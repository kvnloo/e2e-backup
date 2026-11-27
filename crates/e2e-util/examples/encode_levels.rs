//! Times the PNG encoder at each compression level on the PNGs given, and prints the sizes:
//! `cargo run --release -p e2e-util --example encode_levels -- <file.png>...`.

use png::{BitDepth, ColorType, Compression, DeflateCompression, Encoder, Filter};
use std::time::Instant;

fn main() {
    for file in std::env::args().skip(1) {
        let bytes = std::fs::read(&file).expect("read the PNG");
        let image = e2e_util::image::decode_png(&bytes).expect("decode the PNG");
        println!("{file}: {}x{}, {} bytes as given", image.width, image.height, bytes.len());
        let levels: Vec<(String, Option<Compression>, Option<DeflateCompression>)> =
            [("fast", Compression::Fast), ("balanced", Compression::Balanced), ("high", Compression::High)]
                .into_iter()
                .map(|(name, level)| (name.to_string(), Some(level), None))
                .chain((1..=6).map(|level| (format!("zlib {level}"), None, Some(DeflateCompression::Level(level)))))
                .collect();
        for (name, level, deflate) in levels {
            let mut best = f64::MAX;
            let mut size = 0;
            for _ in 0..7 {
                let start = Instant::now();
                let mut out = Vec::new();
                let mut encoder = Encoder::new(&mut out, image.width, image.height);
                encoder.set_color(ColorType::Rgba);
                encoder.set_depth(BitDepth::Eight);
                if let Some(level) = level {
                    encoder.set_compression(level);
                }
                if let Some(deflate) = deflate {
                    encoder.set_deflate_compression(deflate);
                }
                encoder.set_filter(Filter::Adaptive);
                let mut writer = encoder.write_header().expect("header");
                writer.write_image_data(&image.data).expect("data");
                writer.finish().expect("finish");
                best = best.min(start.elapsed().as_secs_f64() * 1000.0);
                size = out.len();
            }
            println!("  {name:>8}: {best:7.2} ms, {size} bytes");
        }
    }
}
