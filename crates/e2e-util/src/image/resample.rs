//! The box filter `boxResample` in `@e2e-dev/core`'s `internal/image.ts` used.

use super::{ImageError, Rgba, byte_len};

/// Resamples an image to `width` by `height`, each target pixel the per-channel average of every source pixel it
/// covers, rounded half up. The spans are computed in floating point exactly as the JavaScript did, so a target
/// pixel covers the same source pixels on both sides. Returns a copy when the size already matches, and an error when
/// the target is over [`MAX_IMAGE_BYTES`](super::MAX_IMAGE_BYTES).
pub fn resample_box(image: &Rgba, width: u32, height: u32) -> Result<Rgba, ImageError> {
    byte_len(width, height)?;
    if image.width == width && image.height == height {
        return Ok(image.clone());
    }
    let (source_width, source_height) = (image.width as usize, image.height as usize);
    let (target_width, target_height) = (width as usize, height as usize);
    let mut data = vec![0; target_width * target_height * 4];
    if target_width == 0 || target_height == 0 || source_width == 0 || source_height == 0 {
        return Ok(Rgba { width, height, data });
    }
    let x_ratio = source_width as f64 / target_width as f64;
    let y_ratio = source_height as f64 / target_height as f64;
    let columns: Vec<(usize, usize)> = (0..target_width).map(|tx| span(tx, x_ratio, source_width)).collect();
    let source = &image.data;
    for ty in 0..target_height {
        let (y0, y1) = span(ty, y_ratio, source_height);
        let row = &mut data[ty * target_width * 4..(ty + 1) * target_width * 4];
        for (&(x0, x1), target) in columns.iter().zip(row.as_chunks_mut::<4>().0) {
            let mut sums = [0_u64; 4];
            for y in y0..y1 {
                let start = (y * source_width + x0) * 4;
                for pixel in source[start..start + (x1 - x0) * 4].as_chunks::<4>().0 {
                    sums[0] += u64::from(pixel[0]);
                    sums[1] += u64::from(pixel[1]);
                    sums[2] += u64::from(pixel[2]);
                    sums[3] += u64::from(pixel[3]);
                }
            }
            let count = ((x1 - x0) * (y1 - y0)) as u64;
            for (channel, sum) in target.iter_mut().zip(sums) {
                // `Math.round(sum / count)`: the quotient is never within an f64 ulp of a tie it is not.
                *channel = ((2 * sum + count) / (2 * count)) as u8;
            }
        }
    }
    Ok(Rgba { width, height, data })
}

/// The source pixels `[start, end)` target pixel `at` covers along one axis.
fn span(at: usize, ratio: f64, source: usize) -> (usize, usize) {
    let start = (at as f64 * ratio).floor() as usize;
    let end = ((at + 1) as f64 * ratio).floor() as usize;
    (start, source.min((start + 1).max(end)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn averages_each_box_rounding_half_up() {
        let image = Rgba::new(2, 1, vec![0, 10, 255, 255, 1, 11, 0, 0]).unwrap();
        let half = resample_box(&image, 1, 1).unwrap();
        assert_eq!(half.data, vec![1, 11, 128, 128]);
    }

    #[test]
    fn upsamples_by_repeating() {
        let image = Rgba::new(1, 1, vec![9, 8, 7, 6]).unwrap();
        assert_eq!(resample_box(&image, 2, 2).unwrap().data, [9, 8, 7, 6].repeat(4));
        assert!(matches!(resample_box(&image, 100_000, 100_000), Err(ImageError::Size(_))));
    }
}
