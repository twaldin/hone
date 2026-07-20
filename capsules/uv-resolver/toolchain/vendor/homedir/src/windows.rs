// src/windows.rs
//
// Copyright (C) 2023-2025 James Petersen <m@jamespetersen.ca>
// Licensed under Apache 2.0 OR MIT. See LICENSE-APACHE or LICENSE-MIT

use core::fmt;
use std::{
    alloc::{alloc_zeroed, dealloc, Layout}, mem::align_of, ops::Deref, path::PathBuf, ptr::null_mut
};

use cfg_if::cfg_if;
use widestring::{
    error::{ContainsNul, Utf16Error},
    U16CStr, U16CString, U16Str,
};
use windows::{
    core::{w, Error as WinError, BSTR, PCWSTR, PWSTR},
    Win32::{
        Foundation::{
            CloseHandle, LocalFree, ERROR_INSUFFICIENT_BUFFER, ERROR_NONE_MAPPED, E_OUTOFMEMORY, E_UNEXPECTED, HANDLE, HLOCAL
        },
        Security::{
            Authorization::ConvertSidToStringSidW, GetTokenInformation, LookupAccountNameW,
            TokenUser, SID, SID_NAME_USE, TOKEN_QUERY, TOKEN_USER, PSID
        },
        System::{
            Com::{
                CoCreateInstance, CoSetProxyBlanket, CoTaskMemFree, CLSCTX_INPROC_SERVER,
                EOAC_NONE, RPC_C_AUTHN_LEVEL_CALL, RPC_C_IMP_LEVEL_IMPERSONATE,
            },
            Rpc::{RPC_C_AUTHN_WINNT, RPC_C_AUTHZ_NONE},
            Threading::{GetCurrentProcess, OpenProcessToken},
            Variant::VARIANT,
            Wmi::{
                IWbemLocator, IWbemServices, WbemLocator, WBEM_FLAG_CONNECT_USE_MAX_WAIT,
                WBEM_FLAG_FORWARD_ONLY, WBEM_FLAG_RETURN_IMMEDIATELY, WBEM_INFINITE,
            },
        },
        UI::Shell::{FOLDERID_Profile, SHGetKnownFolderPath, KNOWN_FOLDER_FLAG},
    },
};

#[cfg(feature = "windows-coinitialize")]
use windows::Win32::{
    Foundation::CO_E_NOTINITIALIZED,
    System::Com::{CoInitializeEx, COINIT_MULTITHREADED},
};

/// An identifier for a user.
///
/// This contains the text representation of the user's
/// [SID](https://learn.microsoft.com/en-us/windows-server/identity/ad-ds/manage/understand-security-identifiers).
///
/// See [`UserIdentifier::with_username`] for an example of the usage of this structure.
#[repr(transparent)]
#[derive(Debug, Clone)]
pub struct UserIdentifier(String);

/// This enumeration is the error type returned by this crate's functions
/// on Windows.
#[derive(Debug)]
pub enum GetHomeError {
    /// This represents an error as obtained from Windows' API.
    WindowsError(WinError),
    /// This represents an error when parsing UTF-16 text.
    Utf16Error(Utf16Error),
    /// This represents an error when trying to represent a string that contains
    /// a NUL byte `'\0'` as a C string.
    ContainsNul(ContainsNul<u16>),
    /// This represents an error when a returned pointer was null when it was not expected to be
    /// so.
    NullPointerResult,
}

/// This structure caches the results of the operations necessary to check the profile
/// directory from an SID, see [`GetHomeInstance::query_home`]. This way, multiple
/// queries can be performed at a smaller cost.
pub struct GetHomeInstance(IWbemServices);

/// This function will get the home directory of a user given their username. Internally,
/// it calls [`UserIdentifier::with_username`] followed by [`UserIdentifier::to_home`].
///
/// Calling this function may present some issues if any other parts of the program use
/// [`CoInitializeEx`](https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-coinitializeex).
/// See [for Windows users](crate#for-windows-users) for more information.
pub fn home<S: AsRef<str>>(username: S) -> Result<Option<PathBuf>, GetHomeError> {
    let Some(id) = UserIdentifier::with_username(username)? else {
        return Ok(None);
    };
    id.to_home()
}

/// Get the home directory of the current process' user.
pub fn my_home() -> Result<Option<PathBuf>, GetHomeError> {
    unsafe {
        let out = SHGetKnownFolderPath(&FOLDERID_Profile, KNOWN_FOLDER_FLAG(0), None)?.0;
        // there isn't any documented case where this will occur, but who knows.
        if out.is_null() {
            return Ok(None);
        }
        let s = U16CStr::from_ptr_str(out).to_os_string().into();
        CoTaskMemFree(Some(out.cast()));
        Ok(Some(s))
    }
}

unsafe fn sid_to_string(sid: PSID) -> Result<UserIdentifier, GetHomeError> {
    let mut str_pointer: PWSTR = PWSTR::null();
    // convert the SID to string.
    unsafe { ConvertSidToStringSidW(sid, &mut str_pointer)?; }
    let ret = match unsafe { U16CStr::from_ptr_str(str_pointer.0).to_string() } {
        Ok(v) => v,
        Err(e) => {
            // we already have an error. I won't check for this one.
            unsafe { LocalFree(Some(HLOCAL(str_pointer.0.cast()))); }
            return Err(e.into());
        }
    };
    if unsafe { !LocalFree(Some(HLOCAL(str_pointer.0.cast()))).0.is_null() } {
        Err(WinError::from_win32())?;
    }
    Ok(UserIdentifier(ret))
}

impl UserIdentifier {
    /// Get the user identifier of a user given their username.
    pub fn with_username<S: AsRef<str>>(
        username: S,
    ) -> Result<Option<UserIdentifier>, GetHomeError> {
        unsafe {
            let username = U16CString::from_str(username)?;
            let mut sid_size = 0;
            let mut domain_size = 0;
            let mut peuse = SID_NAME_USE(0);
            // get buffer length necessary for SID.
            if let Err(e) = LookupAccountNameW(
                None,
                PCWSTR(username.as_ptr()),
                None,
                &mut sid_size,
                None,
                &mut domain_size,
                &mut peuse,
            ) {
                if e == ERROR_NONE_MAPPED.into() {
                    return Ok(None);
                } else if e != ERROR_INSUFFICIENT_BUFFER.into() {
                    return Err(e.into());
                }
            }
            if sid_size == 0 {
                return Err(WinError::from(E_UNEXPECTED).into());
            }
            let layout = Layout::from_size_align(sid_size as usize, align_of::<SID>()).unwrap();
            let sid_buf = alloc_zeroed(layout);
            if sid_buf.is_null() {
                return Err(WinError::from(E_OUTOFMEMORY).into());
            }
            // the domain is unfortunately necessary, otherwise the function will not operate
            // correctly.
            let mut domain = vec![0; domain_size as usize];
            let psid = PSID(sid_buf.cast());
            let ret = if let Err(e) = LookupAccountNameW(
                None,
                PCWSTR(username.as_ptr()),
                Some(psid),
                &mut sid_size,
                Some(PWSTR(domain.as_mut_ptr())),
                &mut domain_size,
                &mut peuse,
            ) {
                Err(e.into())
            } else {
                sid_to_string(psid).map(Some)
            };
            dealloc(sid_buf, layout);
            ret
        }
    }

    /// This function will get the home directory of a user given their identifier.
    /// Internally, this function calls [`GetHomeInstance::new`] followed by
    /// [`GetHomeInstance::query_home`].
    ///
    /// Calling this function may present some issues if any other parts of the program use
    /// [`CoInitializeEx`](https://learn.microsoft.com/en-us/windows/win32/api/combaseapi/nf-combaseapi-coinitializeex).
    /// See [for Windows users](crate#for-windows-users) for more information.
    pub fn to_home(&self) -> Result<Option<PathBuf>, GetHomeError> {
        GetHomeInstance::new()?.query_home(self)
    }

    /// Get the identifier of this process' user.
    pub fn my_id() -> Result<UserIdentifier, GetHomeError> {
        unsafe {
            // get the handle of the current process.
            let handle = GetCurrentProcess();
            let mut token_handle = HANDLE(null_mut());
            // get a token to query information about the current process. this handle must be dropped
            // manually with CloseHandle, as seen below.
            OpenProcessToken(handle, TOKEN_QUERY, &mut token_handle)?;
            let mut buffer_size = 0;
            // get the length of the buffer requried for this query.
            if let Err(e) = GetTokenInformation(token_handle, TokenUser, None, 0, &mut buffer_size)
                && e != ERROR_INSUFFICIENT_BUFFER.into()
            {
                _ = CloseHandle(token_handle);
                return Err(e.into());
            }
            if buffer_size == 0 {
                return Err(WinError::from(E_UNEXPECTED).into());
            }
            let layout =
                Layout::from_size_align(buffer_size as usize, align_of::<TOKEN_USER>()).unwrap();
            let buf_ptr = alloc_zeroed(layout);
            if buf_ptr.is_null() {
                CloseHandle(token_handle)?;
                return Err(WinError::from(E_OUTOFMEMORY).into());
            }
            let ret = if let Err(e) = GetTokenInformation(
                token_handle,
                TokenUser,
                Some(buf_ptr.cast()),
                buffer_size,
                &mut buffer_size,
            ) {
                Err(e.into())
            } else {
                sid_to_string((*buf_ptr.cast::<TOKEN_USER>()).User.Sid)
            };
            dealloc(buf_ptr, layout);
            CloseHandle(token_handle)?;
            ret
        }
    }
}

impl GetHomeInstance {
    /// Construct this structure. This connects to the Windows Management Instrumentation.
    pub fn new() -> Result<Self, GetHomeError> {
        unsafe {
            const NAMESPACE_PATH: &str = "ROOT\\CIMV2";
            cfg_if!(
                if #[cfg(feature = "windows-coinitialize")] {
                    let instance_fn = || CoCreateInstance::<_, IWbemLocator>(&WbemLocator, None, CLSCTX_INPROC_SERVER);
                    let instance = match instance_fn() {
                        Ok(v) => v,
                        Err(e) => {
                            if e != CO_E_NOTINITIALIZED.into() {
                                return Err(e.into());
                            }
                            CoInitializeEx(None, COINIT_MULTITHREADED).ok()?;
                            instance_fn()?
                        },
                    };
                } else {
                    let instance = CoCreateInstance::<_, IWbemLocator>(&WbemLocator, None, CLSCTX_INPROC_SERVER)?;
                }
            );
            let nms_path_bstr = BSTR::from(NAMESPACE_PATH);
            let svc = instance.ConnectServer(
                &nms_path_bstr,
                &BSTR::new(),
                &BSTR::new(),
                &BSTR::new(),
                WBEM_FLAG_CONNECT_USE_MAX_WAIT.0,
                &BSTR::new(),
                None,
            )?;
            CoSetProxyBlanket(
                &svc,
                RPC_C_AUTHN_WINNT,
                RPC_C_AUTHZ_NONE,
                None,
                RPC_C_AUTHN_LEVEL_CALL,
                RPC_C_IMP_LEVEL_IMPERSONATE,
                None,
                EOAC_NONE,
            )?;
            Ok(Self(svc))
        }
    }

    /// Get the home directory of a user given their identifier.
    pub fn query_home(&self, id: &UserIdentifier) -> Result<Option<PathBuf>, GetHomeError> {
        unsafe {
            let query_enum = self.0.ExecQuery(
                &BSTR::from("WQL"),
                &BSTR::from(format!(
                    "SELECT LocalPath FROM Win32_UserProfile WHERE SID = '{}'",
                    id.0
                )),
                WBEM_FLAG_FORWARD_ONLY | WBEM_FLAG_RETURN_IMMEDIATELY,
                None,
            )?;
            let mut ret = [None; 1];
            let mut ret_count = 0;
            query_enum
                .Next(WBEM_INFINITE, &mut ret, &mut ret_count)
                .ok()?;
            if ret_count == 0 {
                return Ok(None);
            }
            let [ret] = ret;
            let ret = ret.ok_or(GetHomeError::NullPointerResult)?;
            let name = w!("LocalPath");
            let mut variant = VARIANT::default();
            let mut vt_type = 0;
            ret.Get(name, 0, &mut variant, Some(&mut vt_type), None)?;
            Ok(Some(
                U16Str::from_slice(variant.Anonymous.Anonymous.Anonymous.bstrVal.deref().deref()).to_os_string().into(),
            ))
        }
    }
}

impl From<WinError> for GetHomeError {
    fn from(value: WinError) -> Self {
        Self::WindowsError(value)
    }
}

impl From<Utf16Error> for GetHomeError {
    fn from(value: Utf16Error) -> Self {
        Self::Utf16Error(value)
    }
}

impl From<ContainsNul<u16>> for GetHomeError {
    fn from(value: ContainsNul<u16>) -> Self {
        Self::ContainsNul(value)
    }
}

impl fmt::Display for GetHomeError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::WindowsError(e) => write!(f, "windows error: {e}"),
            Self::Utf16Error(e) => write!(f, "utf-16 error: {e}"),
            Self::ContainsNul(e) => write!(f, "str contains NUL: {e}"),
            Self::NullPointerResult => write!(f, "unexpected null pointer result"),
        }
    }
}

impl std::error::Error for GetHomeError {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::WindowsError(e) => Some(e),
            Self::Utf16Error(e) => Some(e),
            Self::ContainsNul(e) => Some(e),
            Self::NullPointerResult => None,
        }
    }
}

impl AsRef<str> for UserIdentifier {
    fn as_ref(&self) -> &str {
        &self.0
    }
}

impl From<UserIdentifier> for String {
    fn from(value: UserIdentifier) -> Self {
        value.0
    }
}
