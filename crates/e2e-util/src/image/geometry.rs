//! Boxes on an image: clipping, cropping, and painting.

use super::{Box, ImageError, Rgba, js};

/// A box of whole pixels inside an image.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PixelBox {
    pub x: u32,
    pub y: u32,
    pub width: u32,
    pub height: u32,
}

/// The part of `area` inside a `width` by `height` image, on whole pixels, each edge rounded with `Math.round`;
/// `None` when none of it is, or when a coordinate is not a number.
pub fn clip_box(width: u32, height: u32, area: Box) -> Option<PixelBox> {
    let x0 = js::max(0.0, js::round(area.x));
    let y0 = js::max(0.0, js::round(area.y));
    let x1 = js::min(f64::from(width), js::round(area.x + area.width));
    let y1 = js::min(f64::from(height), js::round(area.y + area.height));
    if x1 > x0 && y1 > y0 { Some(PixelBox { x: x0 as u32, y: y0 as u32, width: (x1 - x0) as u32, height: (y1 - y0) as u32 }) } else { None }
}

/// The pixels of a box inside the image (see [`clip_box`]).
pub fn crop(image: &Rgba, area: PixelBox) -> Result<Rgba, ImageError> {
    let inside = u64::from(area.x) + u64::from(area.width) <= u64::from(image.width) && u64::from(area.y) + u64::from(area.height) <= u64::from(image.height);
    if !inside {
        return Err(ImageError::Size(format!(
            "a {}x{} box at {},{} is not inside a {}x{} image",
            area.width, area.height, area.x, area.y, image.width, image.height
        )));
    }
    let (stride, row) = (image.width as usize * 4, area.width as usize * 4);
    let mut data = Vec::with_capacity(row * area.height as usize);
    for y in area.y as usize..(area.y + area.height) as usize {
        let from = y * stride + area.x as usize * 4;
        data.extend_from_slice(&image.data[from..from + row]);
    }
    Ok(Rgba { width: area.width, height: area.height, data })
}

/// A copy of the image with each box, clipped to it, painted opaque in `color`.
pub fn fill_boxes(image: &Rgba, boxes: &[Box], color: [u8; 3]) -> Rgba {
    let mut copy = image.clone();
    fill_boxes_in_place(&mut copy, boxes, color);
    copy
}

/// Paints each box, clipped to the image, opaque in `color`.
pub fn fill_boxes_in_place(image: &mut Rgba, boxes: &[Box], color: [u8; 3]) {
    let pixel = [color[0], color[1], color[2], 255];
    let stride = image.width as usize * 4;
    for &area in boxes {
        let Some(clipped) = clip_box(image.width, image.height, area) else { continue };
        let (x0, x1) = (clipped.x as usize * 4, (clipped.x + clipped.width) as usize * 4);
        for y in clipped.y as usize..(clipped.y + clipped.height) as usize {
            for target in image.data[y * stride + x0..y * stride + x1].as_chunks_mut::<4>().0 {
                target.copy_from_slice(&pixel);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clips_with_javascript_rounding() {
        let clipped = clip_box(10, 10, Box { x: -0.5, y: 2.5, width: 3.0, height: 100.0 });
        assert_eq!(clipped, Some(PixelBox { x: 0, y: 3, width: 3, height: 7 }));
        assert_eq!(clip_box(10, 10, Box { x: 12.0, y: 0.0, width: 3.0, height: 3.0 }), None);
        assert_eq!(clip_box(10, 10, Box { x: f64::NAN, y: 0.0, width: 3.0, height: 3.0 }), None);
    }

    #[test]
    fn paints_and_crops() {
        let image = Rgba::new(3, 2, vec![7; 24]).unwrap();
        let painted = fill_boxes(&image, &[Box { x: 1.0, y: 0.0, width: 5.0, height: 1.0 }], [1, 2, 3]);
        let top = crop(&painted, PixelBox { x: 1, y: 0, width: 2, height: 1 }).unwrap();
        assert_eq!(top.data, vec![1, 2, 3, 255, 1, 2, 3, 255]);
        assert!(crop(&painted, PixelBox { x: 2, y: 0, width: 2, height: 1 }).is_err());
    }
}
