// Copyright (c) 2021-2024 Harry [Majored] [hello@majored.pw]
// MIT License (https://github.com/Majored/rs-async-zip/blob/main/LICENSE)

pub mod builder;

#[cfg(feature = "jiff")]
use jiff::{civil, tz::Offset, Timestamp};

use self::builder::ZipDateTimeBuilder;

// https://github.com/Majored/rs-async-zip/blob/main/SPECIFICATION.md#446
// https://learn.microsoft.com/en-us/windows/win32/api/oleauto/nf-oleauto-dosdatetimetovarianttime

/// A date and time stored as per the MS-DOS representation used by ZIP files.
#[derive(Debug, PartialEq, Eq, Clone, Copy, Hash)]
pub struct ZipDateTime {
    pub(crate) date: u16,
    pub(crate) time: u16,
}

impl Default for ZipDateTime {
    fn default() -> Self {
        ZipDateTimeBuilder::new().year(1980).month(1).day(1).build()
    }
}

impl ZipDateTime {
    /// Returns the current time if the `jiff` feature is enabled, otherwise the default of 1980-01-01.
    pub fn default_for_write() -> Self {
        #[cfg(feature = "jiff")]
        {
            Self::from_jiff(&Offset::UTC.to_datetime(Timestamp::now()))
        }

        #[cfg(not(feature = "jiff"))]
        {
            Self::default()
        }
    }

    /// Returns the year of this date & time.
    pub fn year(&self) -> i32 {
        (((self.date & 0xFE00) >> 9) + 1980).into()
    }

    /// Returns the month of this date & time.
    pub fn month(&self) -> u32 {
        ((self.date & 0x1E0) >> 5).into()
    }

    /// Returns the day of this date & time.
    pub fn day(&self) -> u32 {
        (self.date & 0x1F).into()
    }

    /// Returns the hour of this date & time.
    pub fn hour(&self) -> u32 {
        ((self.time & 0xF800) >> 11).into()
    }

    /// Returns the minute of this date & time.
    pub fn minute(&self) -> u32 {
        ((self.time & 0x7E0) >> 5).into()
    }

    /// Returns the second of this date & time.
    ///
    /// Note that MS-DOS has a maximum granularity of two seconds.
    pub fn second(&self) -> u32 {
        ((self.time & 0x1F) << 1).into()
    }

    /// Constructs Jiff's [`civil::DateTime`] representation of this date & time.
    ///
    /// Note that this requires the `jiff` feature.
    #[cfg(feature = "jiff")]
    pub fn as_jiff(&self) -> Result<civil::DateTime, jiff::Error> {
        self.try_into()
    }

    /// Constructs this date & time from Jiff's [`civil::DateTime`] representation.
    ///
    /// Note that this requires the `jiff` feature.
    #[cfg(feature = "jiff")]
    pub fn from_jiff(date_time: &civil::DateTime) -> Self {
        date_time.into()
    }
}

impl From<ZipDateTimeBuilder> for ZipDateTime {
    fn from(builder: ZipDateTimeBuilder) -> Self {
        builder.0
    }
}

#[cfg(feature = "jiff")]
impl From<&civil::DateTime> for ZipDateTime {
    fn from(value: &civil::DateTime) -> Self {
        let mut builder = ZipDateTimeBuilder::new();

        builder = builder.year(value.year().into());
        builder = builder.month(value.month() as u32);
        builder = builder.day(value.day() as u32);
        builder = builder.hour(value.hour() as u32);
        builder = builder.minute(value.minute() as u32);
        builder = builder.second(value.second() as u32);

        builder.build()
    }
}

#[cfg(feature = "jiff")]
impl TryFrom<&ZipDateTime> for civil::DateTime {
    type Error = jiff::Error;

    fn try_from(value: &ZipDateTime) -> Result<Self, Self::Error> {
        Self::new(
            value.year() as i16,
            value.month() as i8,
            value.day() as i8,
            value.hour() as i8,
            value.minute() as i8,
            value.second() as i8,
            0,
        )
    }
}

#[cfg(feature = "jiff")]
impl From<civil::DateTime> for ZipDateTime {
    fn from(value: civil::DateTime) -> Self {
        (&value).into()
    }
}

#[cfg(feature = "jiff")]
impl TryFrom<ZipDateTime> for civil::DateTime {
    type Error = jiff::Error;

    fn try_from(value: ZipDateTime) -> Result<Self, Self::Error> {
        (&value).try_into()
    }
}
