//! RGBA images in memory: PNG decoding and encoding, box resampling, cropping, painting boxes, and comparing two
//! images the way pixelmatch 8 does.

mod codec;
mod compare;
mod geometry;
mod js;
mod lin_table;
mod resample;

pub use codec::{decode_png, encode_png, png_size};
pub use compare::{Comparison, Tolerance, compare, count_diff_pixels, diff_image};
pub use geometry::{PixelBox, clip_box, crop, fill_boxes, fill_boxes_in_place};
pub use resample::resample_box;

use std::fmt;

/// An image, 8 bits per channel in RGBA order, rows top to bottom.
#[derive(Clone, PartialEq, Eq)]
pub struct Rgba {
    pub width: u32,
    pub height: u32,
    pub data: Vec<u8>,
}

impl Rgba {
    /// An image over `data`, which must hold exactly `width * height` RGBA pixels.
    pub fn new(width: u32, height: u32, data: Vec<u8>) -> Result<Self, ImageError> {
        let expected = byte_len(width, height)?;
        if data.len() != expected {
            return Err(ImageError::Size(format!("a {width}x{height} image is {expected} bytes of RGBA, not {}", data.len())));
        }
        Ok(Self { width, height, data })
    }

    /// Bytes of pixel memory the image holds.
    pub fn byte_len(&self) -> usize {
        self.data.len()
    }
}

impl fmt::Debug for Rgba {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Rgba({}x{})", self.width, self.height)
    }
}

/// A box in image pixels, in the coordinates a caller reads off a screen: fractional, possibly negative, possibly
/// reaching past the image.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Box {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}

/// Why an image could not be read, written, or used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageError {
    /// The bytes are not a PNG, or not one this decoder reads.
    Decode(String),
    /// The encoder refused the image.
    Encode(String),
    /// A size or a box that does not fit the image.
    Size(String),
}

impl fmt::Display for ImageError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Decode(message) | Self::Encode(message) | Self::Size(message) => f.write_str(message),
        }
    }
}

impl std::error::Error for ImageError {}

/// The most pixel memory one image may hold, RGBA or as decoded: the `image` crate's default limit, which
/// `@napi-rs/image` decoded under. A 4K screenshot at 16 bits per channel is 66 MB. The limit turns a PNG header or a
/// resize that asks for gigabytes into an error before anything is allocated, since a failed allocation aborts the
/// process the addon runs in.
pub const MAX_IMAGE_BYTES: usize = 512 * 1024 * 1024;

/// The RGBA byte length of a `width` by `height` image, or an error when it is over [`MAX_IMAGE_BYTES`].
pub(crate) fn byte_len(width: u32, height: u32) -> Result<usize, ImageError> {
    (width as usize)
        .checked_mul(height as usize)
        .and_then(|pixels| pixels.checked_mul(4))
        .filter(|&bytes| bytes <= MAX_IMAGE_BYTES)
        .ok_or_else(|| ImageError::Size(format!("a {width}x{height} image is over the {} MiB an image may hold", MAX_IMAGE_BYTES / 1024 / 1024)))
}
