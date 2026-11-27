//! JavaScript's number semantics where the code this crate replaces depends on them: `Math.round`, `Math.cbrt`,
//! `Math.max` and `Math.min` with NaN, and the conversion a `Uint8Array` store does.

/// `Math.round`: the closest integer, a tie toward +∞. Rust's `f64::round` breaks a tie away from zero, so -0.5
/// rounds to -1 there and to -0 in JavaScript; `floor(x + 0.5)` rounds 0.49999999999999994 up.
pub(super) fn round(x: f64) -> f64 {
    let floor = x.floor();
    if x - floor >= 0.5 { floor + 1.0 } else { floor }
}

/// `Math.max(a, b)`: NaN when either is.
pub(super) fn max(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.max(b) }
}

/// `Math.min(a, b)`: NaN when either is.
pub(super) fn min(a: f64, b: f64) -> f64 {
    if a.is_nan() || b.is_nan() { f64::NAN } else { a.min(b) }
}

/// The byte a `Uint8Array` stores for a number: truncated toward zero, modulo 256, NaN as 0.
pub(super) fn to_uint8(x: f64) -> u8 {
    if !x.is_finite() {
        return 0;
    }
    (x.trunc() as i64).rem_euclid(256) as u8
}

/// `Math.cbrt` as V8 computes it: FreeBSD's `s_cbrt.c` (V8's `base::ieee754::cbrt`). The platform `cbrt` and the
/// `libm` crate's correctly rounded one can differ from it in the last bit.
pub(super) fn cbrt(x: f64) -> f64 {
    const B1: u32 = 715_094_163;
    const B2: u32 = 696_219_795;
    const P0: f64 = f64::from_bits(0x3ffe_03e6_0f61_e692);
    const P1: f64 = f64::from_bits(0xbffe_28e0_92f0_2420);
    const P2: f64 = f64::from_bits(0x3ff9_f160_4a49_d6c2);
    const P3: f64 = f64::from_bits(0xbfe8_44cb_bee7_51d9);
    const P4: f64 = f64::from_bits(0x3fc2_b000_d4e4_edd7);

    let bits = x.to_bits();
    let mut hx = (bits >> 32) as u32;
    let low = bits as u32;
    let sign = hx & 0x8000_0000;
    hx ^= sign;
    if hx >= 0x7ff0_0000 {
        return x + x;
    }
    let mut t: f64;
    if hx < 0x0010_0000 {
        if (hx | low) == 0 {
            return x;
        }
        t = f64::from_bits(0x4350_0000_u64 << 32) * x;
        let high = (t.to_bits() >> 32) as u32;
        t = f64::from_bits(u64::from(sign | ((high & 0x7fff_ffff) / 3 + B2)) << 32);
    } else {
        t = f64::from_bits(u64::from(sign | (hx / 3 + B1)) << 32);
    }
    let r = (t * t) * (t / x);
    t *= (P0 + r * (P1 + r * P2)) + ((r * r) * r) * (P3 + r * P4);
    t = f64::from_bits((t.to_bits().wrapping_add(0x8000_0000)) & 0xffff_ffff_c000_0000);
    let s = t * t;
    let mut r = x / s;
    let w = t + t;
    r = (r - t) / (w + r);
    t + t * r
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_breaks_ties_toward_positive_infinity() {
        assert_eq!(round(0.5), 1.0);
        assert_eq!(round(-0.5), 0.0);
        assert_eq!(round(-1.5), -1.0);
        assert_eq!(round(2.5), 3.0);
        assert_eq!(round(0.499_999_999_999_999_94), 0.0);
        assert_eq!(round(4_503_599_627_370_497.0), 4_503_599_627_370_497.0);
    }

    #[test]
    fn to_uint8_wraps_like_a_typed_array() {
        assert_eq!(to_uint8(255.9), 255);
        assert_eq!(to_uint8(256.0), 0);
        assert_eq!(to_uint8(-1.0), 255);
        assert_eq!(to_uint8(f64::NAN), 0);
    }

    /// FNV-1a over the bit patterns V8's `Math.cbrt` returns for the inputs below, computed in Node 26: the
    /// pixelmatch cube-root table, a sweep of the small values it computes exactly, reciprocals, and subnormals.
    #[test]
    fn cbrt_matches_v8_bit_for_bit() {
        let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
        let mut mix = |value: f64| hash = (hash ^ value.to_bits()).wrapping_mul(0x0000_0100_0000_01b3);
        for i in 0..=4097 {
            mix(cbrt(f64::from(i) / 4096.0));
        }
        for i in 0..200_000 {
            let i = f64::from(i);
            mix(cbrt(i * 9.765_625e-9 + i * 1e-13));
        }
        for i in 1..2000 {
            mix(cbrt(1.0 / f64::from(i)));
        }
        for i in 1..2000 {
            mix(cbrt(-f64::from(i) * 1.37e-310));
        }
        assert_eq!(hash, 0xee35_364b_df22_9f63);
    }
}
