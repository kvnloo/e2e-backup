//! `@e2e-dev/util`'s native half: `e2e-util` loaded into Node through NAPI-RS. This crate only converts types,
//! schedules work off the JavaScript thread, and maps errors; the logic is `e2e-util`'s.
//!
//! Every call that touches pixels runs on a blocking thread of NAPI-RS's tokio runtime and resolves a Promise. At
//! most one call per core runs at once, so a burst of screenshots queues instead of spawning a thread each. A
//! decoded image stays on the native side as a [`NativeImage`], which tells V8 how much memory it holds.

#![allow(unsafe_code)]

use e2e_util::image::{self as img, Rgba};
use napi::bindgen_prelude::*;
use napi_derive::napi;
use std::sync::{Arc, LazyLock};
use tokio::sync::Semaphore;

/// One permit per core: pixel work is CPU-bound, so more threads than cores only add switching.
static PERMITS: LazyLock<Semaphore> = LazyLock::new(|| Semaphore::new(std::thread::available_parallelism().map(std::num::NonZero::get).unwrap_or(4)));

/// Runs `work` on a blocking thread once a permit is free.
async fn blocking<T: Send + 'static>(work: impl FnOnce() -> Result<T> + Send + 'static) -> Result<T> {
    let _permit = PERMITS.acquire().await.map_err(|error| Error::from_reason(error.to_string()))?;
    spawn_blocking(work).await.map_err(|error| Error::from_reason(format!("the native image call failed: {error}")))?
}

fn invalid(error: img::ImageError) -> Error {
    let status = match error {
        img::ImageError::Encode(_) => Status::GenericFailure,
        img::ImageError::Decode(_) | img::ImageError::Size(_) => Status::InvalidArg,
    };
    Error::new(status, error.to_string())
}

/// An image's width and height.
#[napi(object)]
pub struct ImageSize {
    pub width: u32,
    pub height: u32,
}

/// A box in image pixels: fractional, possibly negative, possibly past the image.
#[napi(object)]
#[derive(Clone, Copy)]
pub struct ImageBox {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

impl From<ImageBox> for img::Box {
    fn from(value: ImageBox) -> Self {
        Self { x: value.x, y: value.y, width: value.width, height: value.height }
    }
}

/// Boxes to paint opaque in one color.
#[napi(object)]
pub struct FillStep {
    pub boxes: Vec<ImageBox>,
    #[napi(ts_type = "readonly [number, number, number]")]
    pub color: Vec<u8>,
}

/// A target size, read as numbers so a value past `u32` is refused rather than wrapped.
#[napi(object)]
pub struct TargetSize {
    pub width: f64,
    pub height: f64,
}

/// What `processPng` does to a decoded PNG, in this order: resample, crop, paint.
#[napi(object)]
pub struct ProcessSteps {
    pub resize: Option<TargetSize>,
    /// Clipped to the image first; a box with nothing inside fails the call.
    pub crop: Option<ImageBox>,
    pub fill: Option<FillStep>,
}

/// How far two images may differ and still match.
#[napi(object)]
pub struct ImageTolerance {
    pub threshold: f64,
    pub max_diff_pixels: Option<f64>,
    pub max_diff_pixel_ratio: Option<f64>,
}

/// What comparing two images found: `kind` is `match`, `size`, or `pixels`.
#[napi(object)]
pub struct RawComparison {
    pub kind: String,
    pub diff_pixels: Option<f64>,
    pub ratio: Option<f64>,
    pub expected: Option<ImageSize>,
    pub actual: Option<ImageSize>,
}

/// An RGBA image held on the native side. Async methods share its pixels with the worker thread rather than
/// copying them, and V8 is told the pixels' size, so many images in a row press the garbage collector as their
/// memory does.
#[napi(custom_finalize)]
pub struct NativeImage {
    image: Arc<Rgba>,
}

impl NativeImage {
    /// Wraps an image and tells V8 it holds its pixels.
    fn adopt(env: &Env, image: Rgba) -> Result<Self> {
        env.adjust_external_memory(image.byte_len() as i64)?;
        Ok(Self { image: Arc::new(image) })
    }
}

impl ObjectFinalize for NativeImage {
    fn finalize(self, env: Env) -> Result<()> {
        env.adjust_external_memory(-(self.image.byte_len() as i64))?;
        Ok(())
    }
}

#[napi]
impl NativeImage {
    #[napi(getter)]
    pub fn width(&self) -> u32 {
        self.image.width
    }

    #[napi(getter)]
    pub fn height(&self) -> u32 {
        self.image.height
    }

    /// An image over a copy of `data`, `width * height` RGBA pixels.
    #[napi(factory)]
    pub fn from_rgba(env: Env, data: &[u8], width: f64, height: f64) -> Result<Self> {
        let (width, height) = dimensions(width, height)?;
        Self::adopt(&env, Rgba::new(width, height, data.to_vec()).map_err(invalid)?)
    }

    /// A copy of the pixels, RGBA, rows top to bottom.
    #[napi]
    pub fn pixels(&self) -> Buffer {
        self.image.data.clone().into()
    }

    /// The image as PNG bytes.
    #[napi(ts_return_type = "Promise<Buffer>")]
    pub fn encode<'env>(&self, env: &'env Env) -> Result<PromiseRaw<'env, Buffer>> {
        let image = Arc::clone(&self.image);
        env.spawn_future(async move { blocking(move || img::encode_png(&image).map(Buffer::from).map_err(invalid)).await })
    }

    /// Compares `actual` against this image, the one expected.
    #[napi(ts_return_type = "Promise<RawComparison>")]
    pub fn compare<'env>(&self, env: &'env Env, actual: &NativeImage, tolerance: ImageTolerance) -> Result<PromiseRaw<'env, RawComparison>> {
        let (expected, actual) = (Arc::clone(&self.image), Arc::clone(&actual.image));
        let tolerance =
            img::Tolerance { threshold: tolerance.threshold, max_diff_pixels: tolerance.max_diff_pixels, max_diff_pixel_ratio: tolerance.max_diff_pixel_ratio };
        env.spawn_future(async move { blocking(move || Ok(raw_comparison(img::compare(&expected, &actual, tolerance)))).await })
    }

    /// The picture of how `actual` differs from this image, which must have its size.
    #[napi(ts_return_type = "Promise<NativeImage>")]
    pub fn diff<'env>(&self, env: &'env Env, actual: &NativeImage, threshold: f64) -> Result<PromiseRaw<'env, NativeImage>> {
        let (expected, actual) = (Arc::clone(&self.image), Arc::clone(&actual.image));
        if expected.width != actual.width || expected.height != actual.height {
            return Err(Error::new(Status::InvalidArg, "a diff needs two images of one size"));
        }
        env.spawn_future_with_callback(async move { blocking(move || Ok(img::diff_image(&expected, &actual, threshold))).await }, |env, image| {
            NativeImage::adopt(env, image)
        })
    }
}

fn raw_comparison(comparison: img::Comparison) -> RawComparison {
    let size = |(width, height)| ImageSize { width, height };
    match comparison {
        img::Comparison::Match { diff_pixels } => {
            RawComparison { kind: "match".into(), diff_pixels: Some(diff_pixels as f64), ratio: None, expected: None, actual: None }
        }
        img::Comparison::Size { expected, actual } => {
            RawComparison { kind: "size".into(), diff_pixels: None, ratio: None, expected: Some(size(expected)), actual: Some(size(actual)) }
        }
        img::Comparison::Pixels { diff_pixels, ratio } => {
            RawComparison { kind: "pixels".into(), diff_pixels: Some(diff_pixels as f64), ratio: Some(ratio), expected: None, actual: None }
        }
    }
}

/// The width and height a PNG's header states, without decoding it; `null` when the bytes are not a PNG.
#[napi]
pub fn png_size(bytes: &[u8]) -> Option<ImageSize> {
    img::png_size(bytes).map(|(width, height)| ImageSize { width, height })
}

/// Decodes PNG bytes to an image held on the native side. The bytes are copied before the work is queued: JavaScript
/// may reuse its buffer while the decode runs.
#[napi(ts_return_type = "Promise<NativeImage>")]
pub fn decode_png<'env>(env: &'env Env, bytes: &[u8]) -> Result<PromiseRaw<'env, NativeImage>> {
    let bytes = bytes.to_vec();
    env.spawn_future_with_callback(async move { blocking(move || img::decode_png(&bytes).map_err(invalid)).await }, NativeImage::adopt)
}

/// Decodes a PNG, applies `steps`, and keeps the result on the native side.
#[napi(ts_return_type = "Promise<NativeImage>")]
pub fn process_png<'env>(env: &'env Env, bytes: &[u8], steps: ProcessSteps) -> Result<PromiseRaw<'env, NativeImage>> {
    let (bytes, steps) = (bytes.to_vec(), Steps::try_from(steps)?);
    env.spawn_future_with_callback(async move { blocking(move || process(&bytes, &steps)).await }, NativeImage::adopt)
}

/// Decodes a PNG, applies `steps`, and encodes the result as PNG bytes: one call, no pixels crossing to JavaScript.
#[napi(ts_return_type = "Promise<Buffer>")]
pub fn process_png_to_png<'env>(env: &'env Env, bytes: &[u8], steps: ProcessSteps) -> Result<PromiseRaw<'env, Buffer>> {
    let (bytes, steps) = (bytes.to_vec(), Steps::try_from(steps)?);
    env.spawn_future(async move {
        blocking(move || {
            let image = process(&bytes, &steps)?;
            img::encode_png(&image).map(Buffer::from).map_err(invalid)
        })
        .await
    })
}

/// [`ProcessSteps`] checked on the JavaScript thread, so a bad argument throws there.
struct Steps {
    resize: Option<(u32, u32)>,
    crop: Option<img::Box>,
    fill: Option<(Vec<img::Box>, [u8; 3])>,
}

impl TryFrom<ProcessSteps> for Steps {
    type Error = Error;

    fn try_from(steps: ProcessSteps) -> Result<Self> {
        let fill = match steps.fill {
            None => None,
            Some(fill) => {
                let color: [u8; 3] =
                    fill.color.try_into().map_err(|_| Error::new(Status::InvalidArg, "a fill color is three channels, red, green, and blue"))?;
                Some((fill.boxes.into_iter().map(img::Box::from).collect(), color))
            }
        };
        let resize = steps.resize.map(|size| dimensions(size.width, size.height)).transpose()?;
        Ok(Self { resize, crop: steps.crop.map(img::Box::from), fill })
    }
}

/// A width and height as whole pixels, 1 to `u32::MAX` each.
fn dimensions(width: f64, height: f64) -> Result<(u32, u32)> {
    let whole = |value: f64| value.fract() == 0.0 && (1.0..=f64::from(u32::MAX)).contains(&value);
    if !whole(width) || !whole(height) {
        return Err(Error::new(Status::InvalidArg, format!("an image size is whole pixels from 1 to {}, not {width}x{height}", u32::MAX)));
    }
    Ok((width as u32, height as u32))
}

fn process(bytes: &[u8], steps: &Steps) -> Result<Rgba> {
    let mut image = img::decode_png(bytes).map_err(invalid)?;
    if let Some((width, height)) = steps.resize
        && (width != image.width || height != image.height)
    {
        image = img::resample_box(&image, width, height).map_err(invalid)?;
    }
    if let Some(area) = steps.crop {
        let clipped =
            img::clip_box(image.width, image.height, area).ok_or_else(|| Error::new(Status::InvalidArg, "the crop box has no pixels inside the image"))?;
        if clipped.x != 0 || clipped.y != 0 || clipped.width != image.width || clipped.height != image.height {
            image = img::crop(&image, clipped).map_err(invalid)?;
        }
    }
    if let Some((boxes, color)) = &steps.fill {
        img::fill_boxes_in_place(&mut image, boxes, *color);
    }
    Ok(image)
}
