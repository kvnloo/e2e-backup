//! Comparing two images: a port of pixelmatch 8 (ISC, Mapbox) with the options `toHaveScreenshot` uses
//! (`includeAA: false`, `alpha: 0.1`, the default colors, the checkerboard on, no window, no ignore mask). It counts
//! the same pixels and draws the same diff, bit for bit: the floating-point steps run in pixelmatch's order, its
//! sRGB table comes from V8, and its `Math.cbrt` is V8's.

use super::{Rgba, js, lin_table::LIN_BITS};
use std::sync::LazyLock;

/// How far two images may differ and still match.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Tolerance {
    /// Per-pixel color distance, 0 to 1, below which two pixels are the same.
    pub threshold: f64,
    pub max_diff_pixels: Option<f64>,
    pub max_diff_pixel_ratio: Option<f64>,
}

/// What comparing two images found.
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Comparison {
    Match { diff_pixels: u64 },
    Size { expected: (u32, u32), actual: (u32, u32) },
    Pixels { diff_pixels: u64, ratio: f64 },
}

/// Compares `actual` against `expected`. They match when they have one size and at most the tolerated number of
/// pixels differ: `max_diff_pixels`, a `max_diff_pixel_ratio` share of the image, the smaller of the two when both
/// are set, and none when neither is.
pub fn compare(expected: &Rgba, actual: &Rgba, tolerance: Tolerance) -> Comparison {
    if expected.width != actual.width || expected.height != actual.height {
        return Comparison::Size { expected: (expected.width, expected.height), actual: (actual.width, actual.height) };
    }
    let diff_pixels = count_diff_pixels(expected, actual, tolerance.threshold);
    let total = f64::from(expected.width) * f64::from(expected.height);
    let by_ratio = tolerance.max_diff_pixel_ratio.map(|ratio| total * ratio);
    let allowed = match (tolerance.max_diff_pixels, by_ratio) {
        (Some(pixels), Some(ratio)) => js::min(pixels, ratio),
        (Some(pixels), None) => pixels,
        (None, Some(ratio)) => ratio,
        (None, None) => 0.0,
    };
    if diff_pixels as f64 <= allowed {
        Comparison::Match { diff_pixels }
    } else {
        Comparison::Pixels { diff_pixels, ratio: if total == 0.0 { 0.0 } else { diff_pixels as f64 / total } }
    }
}

/// The number of pixels pixelmatch counts as different at `threshold`. The images must have one size.
pub fn count_diff_pixels(expected: &Rgba, actual: &Rgba, threshold: f64) -> u64 {
    pixelmatch(&expected.data, &actual.data, None, expected.width as usize, expected.height as usize, threshold)
}

/// The picture of how two images of one size differ: `expected` faded, with every pixel [`count_diff_pixels`]
/// counts at `threshold` painted red, and anti-aliasing yellow.
pub fn diff_image(expected: &Rgba, actual: &Rgba, threshold: f64) -> Rgba {
    let mut data = vec![0; expected.data.len()];
    pixelmatch(&expected.data, &actual.data, Some(&mut data), expected.width as usize, expected.height as usize, threshold);
    Rgba { width: expected.width, height: expected.height, data }
}

const ALPHA: f64 = 0.1;
const AA_COLOR: [u8; 3] = [255, 255, 0];
const DIFF_COLOR: [u8; 3] = [255, 0, 0];

fn pixelmatch(img1: &[u8], img2: &[u8], mut output: Option<&mut [u8]>, width: usize, height: usize, threshold: f64) -> u64 {
    let len = width * height;
    debug_assert_eq!(img1.len(), len * 4);
    debug_assert_eq!(img2.len(), len * 4);
    let a32 = words(img1);
    let b32 = words(img2);
    if a32 == b32 {
        if let Some(output) = output.as_deref_mut() {
            for pos in (0..len * 4).step_by(4) {
                draw_gray_pixel(output, pos, img1);
            }
        }
        return 0;
    }
    let tables = &*TABLES;
    let mut cache = OklabCache::new();
    let mut diff = 0;
    for i in 0..len {
        let pos = i * 4;
        let delta = if a32[i] == b32[i] { 0 } else { color_delta(img1, img2, pos, threshold, tables, &mut cache) };
        if delta != 0 {
            let (x, y) = (i % width, i / width);
            let excluded_aa = antialiased(img1, x, y, width, height, &a32, &b32) || antialiased(img2, x, y, width, height, &b32, &a32);
            if excluded_aa {
                if let Some(output) = output.as_deref_mut() {
                    draw_pixel(output, pos, AA_COLOR);
                }
            } else {
                if let Some(output) = output.as_deref_mut() {
                    // `diffColorAlt` is unset, so a darker pixel is drawn in the same color.
                    draw_pixel(output, pos, DIFF_COLOR);
                }
                diff += 1;
            }
        } else if let Some(output) = output.as_deref_mut() {
            draw_gray_pixel(output, pos, img1);
        }
    }
    diff
}

/// Each pixel as one word, for the equality tests pixelmatch makes through a `Uint32Array`.
fn words(bytes: &[u8]) -> Vec<u32> {
    bytes.as_chunks::<4>().0.iter().map(|pixel| u32::from_ne_bytes(*pixel)).collect()
}

fn antialiased(img: &[u8], x1: usize, y1: usize, width: usize, height: usize, a32: &[u32], b32: &[u32]) -> bool {
    let x0 = x1.saturating_sub(1);
    let y0 = y1.saturating_sub(1);
    let x2 = if x1 + 1 < width { x1 + 1 } else { width - 1 };
    let y2 = if y1 + 1 < height { y1 + 1 } else { height - 1 };
    let pos4 = (y1 * width + x1) * 4;
    let (cr, cg, cb, ca) = (img[pos4], img[pos4 + 1], img[pos4 + 2], img[pos4 + 3]);
    let mut zeroes = u32::from(x1 == x0 || x1 == x2 || y1 == y0 || y1 == y2);
    let (mut min, mut max) = (0.0_f64, 0.0_f64);
    let (mut min_x, mut min_y, mut max_x, mut max_y) = (0, 0, 0, 0);
    for x in x0..=x2 {
        for y in y0..=y2 {
            if x == x1 && y == y1 {
                continue;
            }
            let delta = brightness_delta(img, (y * width + x) * 4, cr, cg, cb, ca);
            if delta == 0.0 {
                zeroes += 1;
                if zeroes > 2 {
                    return false;
                }
            } else if delta < min {
                min = delta;
                min_x = x;
                min_y = y;
            } else if delta > max {
                max = delta;
                max_x = x;
                max_y = y;
            }
        }
    }
    if min == 0.0 || max == 0.0 {
        return false;
    }
    (has_many_siblings(a32, min_x, min_y, width, height) && has_many_siblings(b32, min_x, min_y, width, height))
        || (has_many_siblings(a32, max_x, max_y, width, height) && has_many_siblings(b32, max_x, max_y, width, height))
}

fn has_many_siblings(img: &[u32], x1: usize, y1: usize, width: usize, height: usize) -> bool {
    let pos1 = y1 * width + x1;
    let val = img[pos1];
    if x1 > 0 && x1 < width - 1 && y1 > 0 && y1 < height - 1 {
        let same = [
            img[pos1 - width - 1],
            img[pos1 - 1],
            img[pos1 + width - 1],
            img[pos1 - width],
            img[pos1 + width],
            img[pos1 - width + 1],
            img[pos1 + 1],
            img[pos1 + width + 1],
        ];
        return same.iter().filter(|&&other| other == val).count() > 2;
    }
    let x0 = x1.saturating_sub(1);
    let y0 = y1.saturating_sub(1);
    let x2 = if x1 + 1 < width { x1 + 1 } else { width - 1 };
    let y2 = if y1 + 1 < height { y1 + 1 } else { height - 1 };
    let mut zeroes = u32::from(x1 == x0 || x1 == x2 || y1 == y0 || y1 == y2);
    for x in x0..=x2 {
        for y in y0..=y2 {
            if x == x1 && y == y1 {
                continue;
            }
            zeroes += u32::from(val == img[y * width + x]);
            if zeroes > 2 {
                return true;
            }
        }
    }
    false
}

fn brightness_delta(img: &[u8], m: usize, r1: u8, g1: u8, b1: u8, a1: u8) -> f64 {
    let (r1, g1, b1, a1) = (f64::from(r1), f64::from(g1), f64::from(b1), f64::from(a1));
    let (r2, g2, b2, a2) = (f64::from(img[m]), f64::from(img[m + 1]), f64::from(img[m + 2]), f64::from(img[m + 3]));
    let (mut dr, mut dg, mut db) = (r1 - r2, g1 - g2, b1 - b2);
    let da = a1 - a2;
    if dr == 0.0 && dg == 0.0 && db == 0.0 && da == 0.0 {
        return 0.0;
    }
    if a1 < 255.0 || a2 < 255.0 {
        dr = (r1 * a1 - r2 * a2 - 255.0 * da) / 255.0;
        dg = (g1 * a1 - g2 * a2 - 255.0 * da) / 255.0;
        db = (b1 * a1 - b2 * a2 - 255.0 * da) / 255.0;
        let d = dr * 0.298_895_31 + dg * 0.586_622_47 + db * 0.114_482_23;
        return if d == 0.0 && da != 0.0 { da / 2.0 } else { d };
    }
    dr * 0.298_895_31 + dg * 0.586_622_47 + db * 0.114_482_23
}

fn draw_pixel(output: &mut [u8], pos: usize, [r, g, b]: [u8; 3]) {
    output[pos..pos + 4].copy_from_slice(&[r, g, b, 255]);
}

fn draw_gray_pixel(output: &mut [u8], i: usize, img: &[u8]) {
    let luma = f64::from(img[i]) * 0.298_895_31 + f64::from(img[i + 1]) * 0.586_622_47 + f64::from(img[i + 2]) * 0.114_482_23;
    let val = js::to_uint8(255.0 + (luma - 255.0) * ALPHA * f64::from(img[i + 3]) / 255.0);
    output[i..i + 4].copy_from_slice(&[val, val, val, 255]);
}

const CBRT_N: usize = 4096;
const CBRT_EXACT: i64 = 8;
const TOE_K1: f64 = 0.206;
const TOE_K2: f64 = 0.03;
const TOE_K3: f64 = (1.0 + TOE_K1) / (1.0 + TOE_K2);

/// pixelmatch's lookup tables, built once per process.
struct Tables {
    lin: [f64; 257],
    cbrt: Vec<f64>,
    l: [[f64; 256]; 3],
    m: [[f64; 256]; 3],
    s: [[f64; 256]; 3],
}

static TABLES: LazyLock<Tables> = LazyLock::new(|| {
    let lin = LIN_BITS.map(f64::from_bits);
    let cbrt = (0..=CBRT_N + 1).map(|i| js::cbrt(i as f64 / CBRT_N as f64)).collect();
    let mut l = [[0.0; 256]; 3];
    let mut m = [[0.0; 256]; 3];
    let mut s = [[0.0; 256]; 3];
    for i in 0..256 {
        let lr = lin[i];
        l[0][i] = 0.412_221_470_8 * lr;
        m[0][i] = 0.211_903_498_2 * lr;
        s[0][i] = 0.088_302_461_9 * lr;
        l[1][i] = 0.536_332_536_3 * lr;
        m[1][i] = 0.680_699_545_1 * lr;
        s[1][i] = 0.281_718_837_6 * lr;
        l[2][i] = 0.051_445_992_9 * lr;
        m[2][i] = 0.107_396_956_6 * lr;
        s[2][i] = 0.629_978_700_5 * lr;
    }
    Tables { lin, cbrt, l, m, s }
});

impl Tables {
    /// sRGB to linear for a fractional channel value, interpolating the table.
    fn lin_lut(&self, x: f64) -> f64 {
        let i = x as usize;
        self.lin[i] + (self.lin[i + 1] - self.lin[i]) * (x - i as f64)
    }

    /// The cube root over [0, 1], interpolating the table above its first few entries.
    fn cbrt_lut(&self, x: f64) -> f64 {
        let t = x * CBRT_N as f64;
        let i = t as i64;
        if i < CBRT_EXACT {
            return js::cbrt(x);
        }
        let i = i as usize;
        match (self.cbrt.get(i), self.cbrt.get(i + 1)) {
            (Some(&at), Some(&next)) => at + (next - at) * (t - i as f64),
            // JavaScript reads `undefined` past the end, and the arithmetic gives NaN.
            _ => f64::NAN,
        }
    }

    /// Cube-rooted LMS and toe-corrected lightness of an opaque color.
    fn oklab(&self, r: u8, g: u8, b: u8) -> [f64; 4] {
        let (r, g, b) = (r as usize, g as usize, b as usize);
        let l = self.cbrt_lut(self.l[0][r] + self.l[1][g] + self.l[2][b]);
        let m = self.cbrt_lut(self.m[0][r] + self.m[1][g] + self.m[2][b]);
        let s = self.cbrt_lut(self.s[0][r] + self.s[1][g] + self.s[2][b]);
        [l, m, s, lightness(l, m, s)]
    }
}

/// pixelmatch's direct-mapped cache of opaque colors' OKLab values, one per comparison.
struct OklabCache {
    keys: Vec<u32>,
    values: Vec<[f64; 4]>,
}

const OKLAB_CACHE_BITS: u32 = 12;

impl OklabCache {
    fn new() -> Self {
        Self { keys: vec![0; 1 << OKLAB_CACHE_BITS], values: vec![[0.0; 4]; 1 << OKLAB_CACHE_BITS] }
    }

    fn get(&mut self, tables: &Tables, r: u8, g: u8, b: u8) -> [f64; 4] {
        let key = (u32::from(r) << 16) | (u32::from(g) << 8) | u32::from(b);
        let slot = (key.wrapping_mul(0x9e37_79b1) >> (32 - OKLAB_CACHE_BITS)) as usize;
        if self.keys[slot] == key + 1 {
            return self.values[slot];
        }
        let value = tables.oklab(r, g, b);
        self.keys[slot] = key + 1;
        self.values[slot] = value;
        value
    }
}

fn color_delta(img1: &[u8], img2: &[u8], k: usize, max_delta: f64, tables: &Tables, cache: &mut OklabCache) -> i8 {
    let (r1, g1, b1, a1) = (img1[k], img1[k + 1], img1[k + 2], img1[k + 3]);
    let (r2, g2, b2, a2) = (img2[k], img2[k + 1], img2[k + 2], img2[k + 3]);
    if a1 == 255 && a2 == 255 {
        let [l1, m1, s1, lr1] = cache.get(tables, r1, g1, b1);
        let [l2, m2, s2, lr2] = cache.get(tables, r2, g2, b2);
        return oklab_hyab_delta(lr1 - lr2, l1 - l2, m1 - m2, s1 - s2, max_delta);
    }
    color_delta_transparent([r1, g1, b1, a1], [r2, g2, b2, a2], k, max_delta, tables)
}

fn color_delta_transparent(one: [u8; 4], two: [u8; 4], k: usize, max_delta: f64, tables: &Tables) -> i8 {
    // One of 8 backgrounds per pixel, from the top bits of a Fibonacci hash of its index.
    let h = ((k >> 2) as u32).wrapping_mul(0x9e37_79b1);
    let rb = f64::from(48 + 159 * (h >> 31));
    let gb = f64::from(48 + 159 * ((h >> 30) & 1));
    let bb = f64::from(48 + 159 * ((h >> 29) & 1));
    let blend = |[r, g, b, a]: [u8; 4]| {
        let a = f64::from(a);
        ((f64::from(r) * a + rb * (255.0 - a)) / 255.0, (f64::from(g) * a + gb * (255.0 - a)) / 255.0, (f64::from(b) * a + bb * (255.0 - a)) / 255.0)
    };
    let (r1, g1, b1) = blend(one);
    let (r2, g2, b2) = blend(two);
    let (lr1, lg1, lb1) = (tables.lin_lut(r1), tables.lin_lut(g1), tables.lin_lut(b1));
    let (lr2, lg2, lb2) = (tables.lin_lut(r2), tables.lin_lut(g2), tables.lin_lut(b2));
    let l1 = tables.cbrt_lut(0.412_221_470_8 * lr1 + 0.536_332_536_3 * lg1 + 0.051_445_992_9 * lb1);
    let m1 = tables.cbrt_lut(0.211_903_498_2 * lr1 + 0.680_699_545_1 * lg1 + 0.107_396_956_6 * lb1);
    let s1 = tables.cbrt_lut(0.088_302_461_9 * lr1 + 0.281_718_837_6 * lg1 + 0.629_978_700_5 * lb1);
    let l2 = tables.cbrt_lut(0.412_221_470_8 * lr2 + 0.536_332_536_3 * lg2 + 0.051_445_992_9 * lb2);
    let m2 = tables.cbrt_lut(0.211_903_498_2 * lr2 + 0.680_699_545_1 * lg2 + 0.107_396_956_6 * lb2);
    let s2 = tables.cbrt_lut(0.088_302_461_9 * lr2 + 0.281_718_837_6 * lg2 + 0.629_978_700_5 * lb2);
    oklab_hyab_delta(lightness(l1, m1, s1) - lightness(l2, m2, s2), l1 - l2, m1 - m2, s1 - s2, max_delta)
}

fn oklab_hyab_delta(d_lr: f64, dl: f64, dm: f64, ds: f64, max_delta: f64) -> i8 {
    let rest = max_delta - d_lr.abs();
    if rest >= 0.0 {
        let da = 1.977_998_495_1 * dl - 2.428_592_205 * dm + 0.450_593_709_9 * ds;
        let db = 0.025_904_037_1 * dl + 0.782_771_766_2 * dm - 0.808_675_766 * ds;
        if da * da + db * db <= rest * rest {
            return 0;
        }
    }
    if d_lr > 0.0 { -1 } else { 1 }
}

fn lightness(l: f64, m: f64, s: f64) -> f64 {
    let big_l = 0.210_454_255_3 * l + 0.793_617_785 * m - 0.004_072_046_8 * s;
    let x = TOE_K3 * big_l - TOE_K1;
    0.5 * (x + (x * x + 4.0 * TOE_K2 * TOE_K3 * big_l).sqrt())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn solid(width: u32, height: u32, pixel: [u8; 4]) -> Rgba {
        Rgba::new(width, height, pixel.repeat((width * height) as usize)).unwrap()
    }

    #[test]
    fn identical_images_match_with_a_faded_diff() {
        let image = solid(3, 3, [0, 0, 0, 255]);
        let exact = Tolerance { threshold: 0.0, max_diff_pixels: None, max_diff_pixel_ratio: None };
        assert_eq!(compare(&image, &image, exact), Comparison::Match { diff_pixels: 0 });
        // 255 + (0 - 255) * 0.1 = 229.5, stored as 229.
        assert_eq!(&diff_image(&image, &image, 0.0).data[..4], &[229, 229, 229, 255]);
    }

    #[test]
    fn counts_a_changed_pixel_and_applies_the_budget() {
        let expected = solid(5, 5, [255, 255, 255, 255]);
        let mut actual = expected.clone();
        actual.data[12 * 4..12 * 4 + 4].copy_from_slice(&[0, 0, 0, 255]);
        let strict = Tolerance { threshold: 0.1, max_diff_pixels: None, max_diff_pixel_ratio: None };
        assert_eq!(compare(&expected, &actual, strict), Comparison::Pixels { diff_pixels: 1, ratio: 1.0 / 25.0 });
        let loose = Tolerance { max_diff_pixels: Some(1.0), ..strict };
        assert_eq!(compare(&expected, &actual, loose), Comparison::Match { diff_pixels: 1 });
        assert_eq!(&diff_image(&expected, &actual, 0.1).data[48..52], &[255, 0, 0, 255]);
    }

    #[test]
    fn reports_a_size_mismatch() {
        let tolerance = Tolerance { threshold: 0.1, max_diff_pixels: None, max_diff_pixel_ratio: None };
        assert_eq!(compare(&solid(1, 2, [0; 4]), &solid(2, 1, [0; 4]), tolerance), Comparison::Size { expected: (1, 2), actual: (2, 1) });
    }
}
