// SPDX-License-Identifier: MPL-2.0
// Copyright ijl (2024-2026)

use core::arch::aarch64::{
    uint8x16_t, vceqq_u8, vcleq_u8, vdupq_n_u8, vld1q_u8, vmaxq_u8, vmaxvq_u8, vst1q_u8,
};

#[allow(dead_code)]
pub(crate) unsafe fn format_escaped_str_impl_neon_128(
    odst: *mut u8,
    value_ptr: *const u8,
    value_len: usize,
) -> usize {
    unsafe {
        const STRIDE: usize = 16;
        let mut dst = odst;
        let mut src = value_ptr;
        let mut remaining = value_len;

        core::ptr::write(dst, b'"');
        dst = dst.add(1);

        let slash = vdupq_n_u8(b'\\');
        let quote = vdupq_n_u8(b'"');
        let control = vdupq_n_u8(0x1f);
        while remaining >= STRIDE {
            let value: uint8x16_t = vld1q_u8(src);
            let special = vmaxq_u8(
                vmaxq_u8(vceqq_u8(value, slash), vceqq_u8(value, quote)),
                vcleq_u8(value, control),
            );
            if vmaxvq_u8(special) != 0 {
                break;
            }
            vst1q_u8(dst, value);
            src = src.add(STRIDE);
            dst = dst.add(STRIDE);
            remaining -= STRIDE;
        }
        impl_format_scalar!(dst, src, remaining);

        core::ptr::write(dst, b'"');
        dst = dst.add(1);
        dst as usize - odst as usize
    }
}
