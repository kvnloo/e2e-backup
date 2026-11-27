//! PNG bytes to RGBA and back.

use super::{ImageError, Rgba, byte_len};
use png::{BitDepth, ColorType, Compression, Decoder, Encoder, Filter, Limits, Transformations};
use std::io::Cursor;

const SIGNATURE: [u8; 8] = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];

/// The most pixel memory one decode may allocate: the `image` crate's default limit, which `@napi-rs/image` decoded
/// under. A 4K screenshot at 16 bits per channel is 66 MB, over the `png` crate's own 64 MiB default.
const DECODE_LIMIT_BYTES: usize = 512 * 1024 * 1024;

/// The width and height a PNG's header states, read without decoding it; `None` when the bytes do not start with a
/// PNG signature and an `IHDR` chunk.
pub fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.len() < 24 || bytes[..8] != SIGNATURE || &bytes[12..16] != b"IHDR" {
        return None;
    }
    let width = u32::from_be_bytes([bytes[16], bytes[17], bytes[18], bytes[19]]);
    let height = u32::from_be_bytes([bytes[20], bytes[21], bytes[22], bytes[23]]);
    Some((width, height))
}

/// Decodes PNG bytes to 8-bit RGBA: any color type, at 1 to 16 bits or with a palette. A palette, sub-byte samples,
/// and a transparent color are expanded by the decoder; gray spreads to three channels, a missing alpha is opaque,
/// and a 16-bit sample scales to 8 bits rounded, as `Math.round(v * 255 / 65535)` does.
pub fn decode_png(bytes: &[u8]) -> Result<Rgba, ImageError> {
    if bytes.len() < 8 || bytes[..8] != SIGNATURE {
        return Err(ImageError::Decode("not a PNG: the bytes do not start with the PNG signature".into()));
    }
    let mut decoder = Decoder::new_with_limits(Cursor::new(bytes), Limits { bytes: DECODE_LIMIT_BYTES });
    decoder.set_transformations(Transformations::EXPAND);
    let mut reader = decoder.read_info().map_err(|error| ImageError::Decode(format!("not a readable PNG: {error}")))?;
    let size = reader.output_buffer_size().ok_or_else(|| ImageError::Decode("the PNG is too large to decode".into()))?;
    let mut buffer = vec![0; size];
    let frame = reader.next_frame(&mut buffer).map_err(|error| ImageError::Decode(format!("not a readable PNG: {error}")))?;
    buffer.truncate(frame.buffer_size());
    let (width, height) = (frame.width, frame.height);
    let pixels = (width as usize) * (height as usize);
    let channels = match frame.color_type {
        ColorType::Grayscale => 1,
        ColorType::GrayscaleAlpha => 2,
        ColorType::Rgb => 3,
        ColorType::Rgba => 4,
        ColorType::Indexed => return Err(ImageError::Decode("the decoder left a palette unexpanded".into())),
    };
    let wide = match frame.bit_depth {
        BitDepth::Eight => false,
        BitDepth::Sixteen => true,
        depth => return Err(ImageError::Decode(format!("the decoder left {depth:?} samples unexpanded"))),
    };
    if buffer.len() != pixels * channels * if wide { 2 } else { 1 } {
        return Err(ImageError::Decode("the decoded PNG pixels do not fill its size".into()));
    }
    let samples = if wide { narrow(&buffer) } else { buffer };
    let data = if channels == 4 { samples } else { spread(&samples, channels, pixels) };
    Rgba::new(width, height, data)
}

/// Encodes an image as PNG bytes, 8-bit RGBA, each row adaptively filtered as `@napi-rs/image` was asked to.
pub fn encode_png(image: &Rgba) -> Result<Vec<u8>, ImageError> {
    let expected = byte_len(image.width, image.height)?;
    if image.data.len() != expected {
        return Err(ImageError::Size(format!("a {}x{} image is {expected} bytes of RGBA, not {}", image.width, image.height, image.data.len())));
    }
    let mut out = Vec::with_capacity(expected / 4 + 1024);
    let mut encoder = Encoder::new(&mut out, image.width, image.height);
    encoder.set_color(ColorType::Rgba);
    encoder.set_depth(BitDepth::Eight);
    encoder.set_compression(Compression::Balanced);
    encoder.set_filter(Filter::Adaptive);
    let mut writer = encoder.write_header().map_err(|error| ImageError::Encode(error.to_string()))?;
    writer.write_image_data(&image.data).map_err(|error| ImageError::Encode(error.to_string()))?;
    writer.finish().map_err(|error| ImageError::Encode(error.to_string()))?;
    Ok(out)
}

/// Big-endian 16-bit samples as 8-bit samples, rounded. `v * 255 / 65535` is never a tie (65535 is 255 times 257,
/// and 257 is odd), so rounding half down here is `Math.round` there.
fn narrow(bytes: &[u8]) -> Vec<u8> {
    bytes.as_chunks::<2>().0.iter().map(|pair| ((u32::from(u16::from_be_bytes([pair[0], pair[1]])) * 255 + 32_767) / 65_535) as u8).collect()
}

/// 8-bit samples of `channels` per pixel (gray, gray and alpha, RGB) as RGBA.
fn spread(samples: &[u8], channels: usize, pixels: usize) -> Vec<u8> {
    let mut out = vec![0; pixels * 4];
    for (from, to) in samples.chunks_exact(channels).zip(out.as_chunks_mut::<4>().0) {
        let (r, g, b, a) = match channels {
            1 => (from[0], from[0], from[0], 255),
            2 => (from[0], from[0], from[0], from[1]),
            _ => (from[0], from[1], from[2], 255),
        };
        to.copy_from_slice(&[r, g, b, a]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn narrow_rounds_like_math_round() {
        for v in 0..=u16::MAX {
            let js = super::super::js::round(f64::from(v) * 255.0 / 65_535.0) as u8;
            assert_eq!(narrow(&v.to_be_bytes())[0], js, "sample {v}");
        }
    }

    #[test]
    fn round_trips_rgba() {
        let data: Vec<u8> = (0..(7 * 5 * 4)).map(|i| (i * 37 % 256) as u8).collect();
        let image = Rgba::new(7, 5, data).unwrap();
        let png = encode_png(&image).unwrap();
        assert_eq!(png_size(&png), Some((7, 5)));
        assert_eq!(decode_png(&png).unwrap(), image);
    }

    #[test]
    fn refuses_bytes_that_are_not_a_png() {
        assert!(matches!(decode_png(b"GIF89a....."), Err(ImageError::Decode(_))));
        assert_eq!(png_size(b"short"), None);
    }

    #[test]
    fn refuses_a_buffer_of_the_wrong_length() {
        let image = Rgba { width: 2, height: 2, data: vec![0; 15] };
        assert!(matches!(encode_png(&image), Err(ImageError::Size(_))));
    }
}
