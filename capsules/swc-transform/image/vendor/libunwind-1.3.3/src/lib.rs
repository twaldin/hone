//! Bindings to libunwind's functions.

#![allow(non_snake_case)]
#![allow(non_upper_case_globals)]
#![allow(non_camel_case_types)]

pub const _STDINT_H: u32 = 1;
pub const _FEATURES_H: u32 = 1;
pub const _DEFAULT_SOURCE: u32 = 1;
pub const __GLIBC_USE_ISOC2X: u32 = 0;
pub const __USE_ISOC11: u32 = 1;
pub const __USE_ISOC99: u32 = 1;
pub const __USE_ISOC95: u32 = 1;
pub const __USE_POSIX_IMPLICITLY: u32 = 1;
pub const _POSIX_SOURCE: u32 = 1;
pub const _POSIX_C_SOURCE: u32 = 200809;
pub const __USE_POSIX: u32 = 1;
pub const __USE_POSIX2: u32 = 1;
pub const __USE_POSIX199309: u32 = 1;
pub const __USE_POSIX199506: u32 = 1;
pub const __USE_XOPEN2K: u32 = 1;
pub const __USE_XOPEN2K8: u32 = 1;
pub const _ATFILE_SOURCE: u32 = 1;
pub const __WORDSIZE: u32 = 64;
pub const __WORDSIZE_TIME64_COMPAT32: u32 = 1;
pub const __SYSCALL_WORDSIZE: u32 = 64;
pub const __TIMESIZE: u32 = 64;
pub const __USE_MISC: u32 = 1;
pub const __USE_ATFILE: u32 = 1;
pub const __USE_FORTIFY_LEVEL: u32 = 0;
pub const __GLIBC_USE_DEPRECATED_GETS: u32 = 0;
pub const __GLIBC_USE_DEPRECATED_SCANF: u32 = 0;
pub const _STDC_PREDEF_H: u32 = 1;
pub const __STDC_IEC_559__: u32 = 1;
pub const __STDC_IEC_60559_BFP__: u32 = 201404;
pub const __STDC_IEC_559_COMPLEX__: u32 = 1;
pub const __STDC_IEC_60559_COMPLEX__: u32 = 201404;
pub const __STDC_ISO_10646__: u32 = 201706;
pub const __GNU_LIBRARY__: u32 = 6;
pub const __GLIBC__: u32 = 2;
pub const __GLIBC_MINOR__: u32 = 35;
pub const _SYS_CDEFS_H: u32 = 1;
pub const __glibc_c99_flexarr_available: u32 = 1;
pub const __LDOUBLE_REDIRECTS_TO_FLOAT128_ABI: u32 = 0;
pub const __HAVE_GENERIC_SELECTION: u32 = 1;
pub const __GLIBC_USE_LIB_EXT2: u32 = 0;
pub const __GLIBC_USE_IEC_60559_BFP_EXT: u32 = 0;
pub const __GLIBC_USE_IEC_60559_BFP_EXT_C2X: u32 = 0;
pub const __GLIBC_USE_IEC_60559_EXT: u32 = 0;
pub const __GLIBC_USE_IEC_60559_FUNCS_EXT: u32 = 0;
pub const __GLIBC_USE_IEC_60559_FUNCS_EXT_C2X: u32 = 0;
pub const __GLIBC_USE_IEC_60559_TYPES_EXT: u32 = 0;
pub const _BITS_TYPES_H: u32 = 1;
pub const _BITS_TYPESIZES_H: u32 = 1;
pub const __OFF_T_MATCHES_OFF64_T: u32 = 1;
pub const __INO_T_MATCHES_INO64_T: u32 = 1;
pub const __RLIM_T_MATCHES_RLIM64_T: u32 = 1;
pub const __STATFS_MATCHES_STATFS64: u32 = 1;
pub const __KERNEL_OLD_TIMEVAL_MATCHES_TIMEVAL64: u32 = 1;
pub const __FD_SETSIZE: u32 = 1024;
pub const _BITS_TIME64_H: u32 = 1;
pub const _BITS_WCHAR_H: u32 = 1;
pub const _BITS_STDINT_INTN_H: u32 = 1;
pub const _BITS_STDINT_UINTN_H: u32 = 1;
pub const INT8_MIN: i32 = -128;
pub const INT16_MIN: i32 = -32768;
pub const INT32_MIN: i32 = -2147483648;
pub const INT8_MAX: u32 = 127;
pub const INT16_MAX: u32 = 32767;
pub const INT32_MAX: u32 = 2147483647;
pub const UINT8_MAX: u32 = 255;
pub const UINT16_MAX: u32 = 65535;
pub const UINT32_MAX: u32 = 4294967295;
pub const INT_LEAST8_MIN: i32 = -128;
pub const INT_LEAST16_MIN: i32 = -32768;
pub const INT_LEAST32_MIN: i32 = -2147483648;
pub const INT_LEAST8_MAX: u32 = 127;
pub const INT_LEAST16_MAX: u32 = 32767;
pub const INT_LEAST32_MAX: u32 = 2147483647;
pub const UINT_LEAST8_MAX: u32 = 255;
pub const UINT_LEAST16_MAX: u32 = 65535;
pub const UINT_LEAST32_MAX: u32 = 4294967295;
pub const INT_FAST8_MIN: i32 = -128;
pub const INT_FAST16_MIN: i64 = -9223372036854775808;
pub const INT_FAST32_MIN: i64 = -9223372036854775808;
pub const INT_FAST8_MAX: u32 = 127;
pub const INT_FAST16_MAX: u64 = 9223372036854775807;
pub const INT_FAST32_MAX: u64 = 9223372036854775807;
pub const UINT_FAST8_MAX: u32 = 255;
pub const UINT_FAST16_MAX: i32 = -1;
pub const UINT_FAST32_MAX: i32 = -1;
pub const INTPTR_MIN: i64 = -9223372036854775808;
pub const INTPTR_MAX: u64 = 9223372036854775807;
pub const UINTPTR_MAX: i32 = -1;
pub const PTRDIFF_MIN: i64 = -9223372036854775808;
pub const PTRDIFF_MAX: u64 = 9223372036854775807;
pub const SIG_ATOMIC_MIN: i32 = -2147483648;
pub const SIG_ATOMIC_MAX: u32 = 2147483647;
pub const SIZE_MAX: i32 = -1;
pub const WINT_MIN: u32 = 0;
pub const WINT_MAX: u32 = 4294967295;
pub type __u_char = ::std::os::raw::c_uchar;
pub type __u_short = ::std::os::raw::c_ushort;
pub type __u_int = ::std::os::raw::c_uint;
pub type __u_long = ::std::os::raw::c_ulong;
pub type __int8_t = ::std::os::raw::c_schar;
pub type __uint8_t = ::std::os::raw::c_uchar;
pub type __int16_t = ::std::os::raw::c_short;
pub type __uint16_t = ::std::os::raw::c_ushort;
pub type __int32_t = ::std::os::raw::c_int;
pub type __uint32_t = ::std::os::raw::c_uint;
pub type __int64_t = ::std::os::raw::c_long;
pub type __uint64_t = ::std::os::raw::c_ulong;
pub type __int_least8_t = __int8_t;
pub type __uint_least8_t = __uint8_t;
pub type __int_least16_t = __int16_t;
pub type __uint_least16_t = __uint16_t;
pub type __int_least32_t = __int32_t;
pub type __uint_least32_t = __uint32_t;
pub type __int_least64_t = __int64_t;
pub type __uint_least64_t = __uint64_t;
pub type __quad_t = ::std::os::raw::c_long;
pub type __u_quad_t = ::std::os::raw::c_ulong;
pub type __intmax_t = ::std::os::raw::c_long;
pub type __uintmax_t = ::std::os::raw::c_ulong;
pub type __dev_t = ::std::os::raw::c_ulong;
pub type __uid_t = ::std::os::raw::c_uint;
pub type __gid_t = ::std::os::raw::c_uint;
pub type __ino_t = ::std::os::raw::c_ulong;
pub type __ino64_t = ::std::os::raw::c_ulong;
pub type __mode_t = ::std::os::raw::c_uint;
pub type __nlink_t = ::std::os::raw::c_ulong;
pub type __off_t = ::std::os::raw::c_long;
pub type __off64_t = ::std::os::raw::c_long;
pub type __pid_t = ::std::os::raw::c_int;
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct __fsid_t {
    pub __val: [::std::os::raw::c_int; 2usize],
}
#[test]
fn bindgen_test_layout___fsid_t() {
    const UNINIT: ::std::mem::MaybeUninit<__fsid_t> = ::std::mem::MaybeUninit::uninit();
    let ptr = UNINIT.as_ptr();
    assert_eq!(
        ::std::mem::size_of::<__fsid_t>(),
        8usize,
        concat!("Size of: ", stringify!(__fsid_t))
    );
    assert_eq!(
        ::std::mem::align_of::<__fsid_t>(),
        4usize,
        concat!("Alignment of ", stringify!(__fsid_t))
    );
    assert_eq!(
        unsafe { ::std::ptr::addr_of!((*ptr).__val) as usize - ptr as usize },
        0usize,
        concat!(
            "Offset of field: ",
            stringify!(__fsid_t),
            "::",
            stringify!(__val)
        )
    );
}
pub type __clock_t = ::std::os::raw::c_long;
pub type __rlim_t = ::std::os::raw::c_ulong;
pub type __rlim64_t = ::std::os::raw::c_ulong;
pub type __id_t = ::std::os::raw::c_uint;
pub type __time_t = ::std::os::raw::c_long;
pub type __useconds_t = ::std::os::raw::c_uint;
pub type __suseconds_t = ::std::os::raw::c_long;
pub type __suseconds64_t = ::std::os::raw::c_long;
pub type __daddr_t = ::std::os::raw::c_int;
pub type __key_t = ::std::os::raw::c_int;
pub type __clockid_t = ::std::os::raw::c_int;
pub type __timer_t = *mut ::std::os::raw::c_void;
pub type __blksize_t = ::std::os::raw::c_long;
pub type __blkcnt_t = ::std::os::raw::c_long;
pub type __blkcnt64_t = ::std::os::raw::c_long;
pub type __fsblkcnt_t = ::std::os::raw::c_ulong;
pub type __fsblkcnt64_t = ::std::os::raw::c_ulong;
pub type __fsfilcnt_t = ::std::os::raw::c_ulong;
pub type __fsfilcnt64_t = ::std::os::raw::c_ulong;
pub type __fsword_t = ::std::os::raw::c_long;
pub type __ssize_t = ::std::os::raw::c_long;
pub type __syscall_slong_t = ::std::os::raw::c_long;
pub type __syscall_ulong_t = ::std::os::raw::c_ulong;
pub type __loff_t = __off64_t;
pub type __caddr_t = *mut ::std::os::raw::c_char;
pub type __intptr_t = ::std::os::raw::c_long;
pub type __socklen_t = ::std::os::raw::c_uint;
pub type __sig_atomic_t = ::std::os::raw::c_int;
pub type int_least8_t = __int_least8_t;
pub type int_least16_t = __int_least16_t;
pub type int_least32_t = __int_least32_t;
pub type int_least64_t = __int_least64_t;
pub type uint_least8_t = __uint_least8_t;
pub type uint_least16_t = __uint_least16_t;
pub type uint_least32_t = __uint_least32_t;
pub type uint_least64_t = __uint_least64_t;
pub type int_fast8_t = ::std::os::raw::c_schar;
pub type int_fast16_t = ::std::os::raw::c_long;
pub type int_fast32_t = ::std::os::raw::c_long;
pub type int_fast64_t = ::std::os::raw::c_long;
pub type uint_fast8_t = ::std::os::raw::c_uchar;
pub type uint_fast16_t = ::std::os::raw::c_ulong;
pub type uint_fast32_t = ::std::os::raw::c_ulong;
pub type uint_fast64_t = ::std::os::raw::c_ulong;
pub type intmax_t = __intmax_t;
pub type uintmax_t = __uintmax_t;
pub type _Unwind_Word = ::std::os::raw::c_ulong;
pub type _Unwind_Sword = ::std::os::raw::c_long;
pub type _Unwind_Ptr = usize;
pub type _Unwind_Internal_Ptr = usize;
pub type _Unwind_Exception_Class = u64;
pub type _sleb128_t = isize;
pub type _uleb128_t = usize;
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct _Unwind_Context {
    _unused: [u8; 0],
}
pub const _Unwind_Reason_Code__URC_NO_REASON: _Unwind_Reason_Code = 0;
pub const _Unwind_Reason_Code__URC_FOREIGN_EXCEPTION_CAUGHT: _Unwind_Reason_Code = 1;
pub const _Unwind_Reason_Code__URC_FATAL_PHASE2_ERROR: _Unwind_Reason_Code = 2;
pub const _Unwind_Reason_Code__URC_FATAL_PHASE1_ERROR: _Unwind_Reason_Code = 3;
pub const _Unwind_Reason_Code__URC_NORMAL_STOP: _Unwind_Reason_Code = 4;
pub const _Unwind_Reason_Code__URC_END_OF_STACK: _Unwind_Reason_Code = 5;
pub const _Unwind_Reason_Code__URC_HANDLER_FOUND: _Unwind_Reason_Code = 6;
pub const _Unwind_Reason_Code__URC_INSTALL_CONTEXT: _Unwind_Reason_Code = 7;
pub const _Unwind_Reason_Code__URC_CONTINUE_UNWIND: _Unwind_Reason_Code = 8;
pub type _Unwind_Reason_Code = ::std::os::raw::c_uint;
pub const _Unwind_Action__UA_SEARCH_PHASE: _Unwind_Action = 1;
pub const _Unwind_Action__UA_CLEANUP_PHASE: _Unwind_Action = 2;
pub const _Unwind_Action__UA_HANDLER_FRAME: _Unwind_Action = 4;
pub const _Unwind_Action__UA_FORCE_UNWIND: _Unwind_Action = 8;
pub const _Unwind_Action__UA_END_OF_STACK: _Unwind_Action = 16;
pub type _Unwind_Action = ::std::os::raw::c_uint;
pub type _Unwind_Exception_Cleanup_Fn = ::std::option::Option<
    unsafe extern "C" fn(arg1: _Unwind_Reason_Code, arg2: *mut _Unwind_Exception),
>;
#[repr(C)]
#[repr(align(16))]
#[derive(Debug, Copy, Clone)]
pub struct _Unwind_Exception {
    pub exception_class: _Unwind_Exception_Class,
    pub exception_cleanup: _Unwind_Exception_Cleanup_Fn,
    pub private_1: _Unwind_Word,
    pub private_2: _Unwind_Word,
}
#[test]
fn bindgen_test_layout__Unwind_Exception() {
    const UNINIT: ::std::mem::MaybeUninit<_Unwind_Exception> = ::std::mem::MaybeUninit::uninit();
    let ptr = UNINIT.as_ptr();
    assert_eq!(
        ::std::mem::size_of::<_Unwind_Exception>(),
        32usize,
        concat!("Size of: ", stringify!(_Unwind_Exception))
    );
    assert_eq!(
        ::std::mem::align_of::<_Unwind_Exception>(),
        16usize,
        concat!("Alignment of ", stringify!(_Unwind_Exception))
    );
    assert_eq!(
        unsafe { ::std::ptr::addr_of!((*ptr).exception_class) as usize - ptr as usize },
        0usize,
        concat!(
            "Offset of field: ",
            stringify!(_Unwind_Exception),
            "::",
            stringify!(exception_class)
        )
    );
    assert_eq!(
        unsafe { ::std::ptr::addr_of!((*ptr).exception_cleanup) as usize - ptr as usize },
        8usize,
        concat!(
            "Offset of field: ",
            stringify!(_Unwind_Exception),
            "::",
            stringify!(exception_cleanup)
        )
    );
    assert_eq!(
        unsafe { ::std::ptr::addr_of!((*ptr).private_1) as usize - ptr as usize },
        16usize,
        concat!(
            "Offset of field: ",
            stringify!(_Unwind_Exception),
            "::",
            stringify!(private_1)
        )
    );
    assert_eq!(
        unsafe { ::std::ptr::addr_of!((*ptr).private_2) as usize - ptr as usize },
        24usize,
        concat!(
            "Offset of field: ",
            stringify!(_Unwind_Exception),
            "::",
            stringify!(private_2)
        )
    );
}
pub type _Unwind_Stop_Fn = ::std::option::Option<
    unsafe extern "C" fn(
        arg1: ::std::os::raw::c_int,
        arg2: _Unwind_Action,
        arg3: _Unwind_Exception_Class,
        arg4: *mut _Unwind_Exception,
        arg5: *mut _Unwind_Context,
        arg6: *mut ::std::os::raw::c_void,
    ) -> _Unwind_Reason_Code,
>;
pub type _Unwind_Personality_Fn = ::std::option::Option<
    unsafe extern "C" fn(
        arg1: ::std::os::raw::c_int,
        arg2: _Unwind_Action,
        arg3: _Unwind_Exception_Class,
        arg4: *mut _Unwind_Exception,
        arg5: *mut _Unwind_Context,
    ) -> _Unwind_Reason_Code,
>;
pub type __personality_routine = _Unwind_Personality_Fn;
pub type _Unwind_Trace_Fn = ::std::option::Option<
    unsafe extern "C" fn(
        arg1: *mut _Unwind_Context,
        arg2: *mut ::std::os::raw::c_void,
    ) -> _Unwind_Reason_Code,
>;
extern "C" {
    pub fn _Unwind_GetGR(arg1: *mut _Unwind_Context, arg2: ::std::os::raw::c_int) -> _Unwind_Word;
}
extern "C" {
    pub fn _Unwind_SetGR(
        arg1: *mut _Unwind_Context,
        arg2: ::std::os::raw::c_int,
        arg3: _Unwind_Word,
    );
}
extern "C" {
    pub fn _Unwind_GetIP(arg1: *mut _Unwind_Context) -> _Unwind_Word;
}
extern "C" {
    pub fn _Unwind_SetIP(arg1: *mut _Unwind_Context, arg2: _Unwind_Word);
}
extern "C" {
    pub fn _Unwind_GetIPInfo(
        arg1: *mut _Unwind_Context,
        arg2: *mut ::std::os::raw::c_int,
    ) -> _Unwind_Word;
}
extern "C" {
    pub fn _Unwind_GetCFA(arg1: *mut _Unwind_Context) -> _Unwind_Word;
}
extern "C" {
    pub fn _Unwind_GetBSP(arg1: *mut _Unwind_Context) -> _Unwind_Word;
}
extern "C" {
    pub fn _Unwind_GetLanguageSpecificData(
        arg1: *mut _Unwind_Context,
    ) -> *mut ::std::os::raw::c_void;
}
extern "C" {
    pub fn _Unwind_GetRegionStart(arg1: *mut _Unwind_Context) -> _Unwind_Ptr;
}
extern "C" {
    pub fn _Unwind_RaiseException(arg1: *mut _Unwind_Exception) -> _Unwind_Reason_Code;
}
extern "C" {
    pub fn _Unwind_ForcedUnwind(
        arg1: *mut _Unwind_Exception,
        arg2: _Unwind_Stop_Fn,
        arg3: *mut ::std::os::raw::c_void,
    ) -> _Unwind_Reason_Code;
}
extern "C" {
    pub fn _Unwind_DeleteException(arg1: *mut _Unwind_Exception);
}
extern "C" {
    pub fn _Unwind_Resume(arg1: *mut _Unwind_Exception);
}
extern "C" {
    pub fn _Unwind_Resume_or_Rethrow(arg1: *mut _Unwind_Exception) -> _Unwind_Reason_Code;
}
extern "C" {
    pub fn _Unwind_Backtrace(
        arg1: _Unwind_Trace_Fn,
        arg2: *mut ::std::os::raw::c_void,
    ) -> _Unwind_Reason_Code;
}
#[repr(C)]
#[derive(Debug, Copy, Clone)]
pub struct SjLj_Function_Context {
    _unused: [u8; 0],
}
pub type _Unwind_FunctionContext_t = *mut SjLj_Function_Context;
extern "C" {
    pub fn _Unwind_SjLj_Register(arg1: _Unwind_FunctionContext_t);
}
extern "C" {
    pub fn _Unwind_SjLj_Unregister(arg1: _Unwind_FunctionContext_t);
}
extern "C" {
    pub fn _Unwind_SjLj_RaiseException(arg1: *mut _Unwind_Exception) -> _Unwind_Reason_Code;
}
extern "C" {
    pub fn _Unwind_SjLj_ForcedUnwind(
        arg1: *mut _Unwind_Exception,
        arg2: _Unwind_Stop_Fn,
        arg3: *mut ::std::os::raw::c_void,
    ) -> _Unwind_Reason_Code;
}
extern "C" {
    pub fn _Unwind_SjLj_Resume(arg1: *mut _Unwind_Exception);
}
extern "C" {
    pub fn _Unwind_SjLj_Resume_or_Rethrow(arg1: *mut _Unwind_Exception) -> _Unwind_Reason_Code;
}
extern "C" {
    pub fn _Unwind_FindEnclosingFunction(
        arg1: *mut ::std::os::raw::c_void,
    ) -> *mut ::std::os::raw::c_void;
}
extern "C" {
    pub fn _Unwind_GetDataRelBase(arg1: *mut _Unwind_Context) -> _Unwind_Ptr;
}
extern "C" {
    pub fn _Unwind_GetTextRelBase(arg1: *mut _Unwind_Context) -> _Unwind_Ptr;
}
