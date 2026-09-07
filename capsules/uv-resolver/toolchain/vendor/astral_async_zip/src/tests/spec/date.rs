// Copyright (c) 2022 Harry [Majored] [hello@majored.pw]
// MIT License (https://github.com/Majored/rs-async-zip/blob/main/LICENSE)

#[cfg(feature = "jiff")]
use jiff::{civil, tz::Offset, Timestamp};

use crate::{ZipDateTime, ZipDateTimeBuilder};

#[test]
fn default_date_is_valid_msdos_epoch() {
    let default = crate::ZipDateTime::default();

    assert_eq!(1980, default.year());
    assert_eq!(1, default.month());
    assert_eq!(1, default.day());
    assert_eq!(0, default.hour());
    assert_eq!(0, default.minute());
    assert_eq!(0, default.second());
}

#[test]
#[cfg(not(feature = "jiff"))]
fn default_for_write_uses_msdos_epoch_without_jiff() {
    assert_eq!(ZipDateTime::default(), ZipDateTime::default_for_write());
}

#[test]
#[cfg(feature = "jiff")]
fn default_for_write_uses_current_time_with_jiff() {
    let default = ZipDateTime::default_for_write();
    let now = Offset::UTC.to_datetime(Timestamp::now());

    assert_eq!(i32::from(now.year()), default.year());
    assert_ne!(ZipDateTime::default(), default);
}

#[test]
#[cfg(feature = "jiff")]
fn date_conversion_test_jiff() {
    let original_date_time = civil::datetime(2022, 10, 23, 18, 15, 2, 0);
    let zip_date_time = ZipDateTime::from_jiff(&original_date_time);
    let result_date_time = zip_date_time.as_jiff().expect("expected valid Jiff civil datetime");

    assert_eq!(result_date_time, original_date_time);
}

#[test]
fn date_conversion_test() {
    let year = 2000;
    let month = 9;
    let day = 8;
    let hour = 7;
    let minute = 5;
    let second = 4;

    let mut builder = ZipDateTimeBuilder::new();

    builder = builder.year(year);
    builder = builder.month(month);
    builder = builder.day(day);
    builder = builder.hour(hour);
    builder = builder.minute(minute);
    builder = builder.second(second);

    let built = builder.build();

    assert_eq!(year, built.year());
    assert_eq!(month, built.month());
    assert_eq!(day, built.day());
    assert_eq!(hour, built.hour());
    assert_eq!(minute, built.minute());
    assert_eq!(second, built.second());
}
