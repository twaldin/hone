// Copyright (c) 2023 Harry [Majored] [hello@majored.pw]
// Copyright (c) 2023 Cognite AS
// MIT License (https://github.com/Majored/rs-async-zip/blob/main/LICENSE)

use crate::base::read::MIN_CENTRAL_DIRECTORY_ENTRY_SIZE;
use crate::error::{Result, ZipError};
use crate::spec::header::{EndOfCentralDirectoryHeader, Zip64EndOfCentralDirectoryRecord};

/// Combines all the fields in EOCDR and Zip64EOCDR into one struct.
#[derive(Debug)]
pub struct CombinedCentralDirectoryRecord {
    pub version_made_by: Option<u16>,
    pub version_needed_to_extract: Option<u16>,
    pub disk_number: u32,
    pub disk_number_start_of_cd: u32,
    pub num_entries_in_directory_on_disk: u64,
    pub num_entries_in_directory: u64,
    pub directory_size: u64,
    pub offset_of_start_of_directory: u64,
    pub file_comment_length: u16,
}

impl CombinedCentralDirectoryRecord {
    /// Combine an EOCDR with an optional Zip64EOCDR.
    ///
    /// Fields that are set to their max value in the EOCDR will be overwritten by the contents of
    /// the corresponding Zip64EOCDR field. Other fields must agree with their Zip64EOCDR
    /// counterparts so that both records describe the same central directory.
    pub fn combine(eocdr: EndOfCentralDirectoryHeader, zip64eocdr: Zip64EndOfCentralDirectoryRecord) -> Result<Self> {
        validate_zip64_field("disk number", eocdr.disk_num as u64, u16::MAX as u64, zip64eocdr.disk_number as u64)?;
        validate_zip64_field(
            "central directory start disk",
            eocdr.start_cent_dir_disk as u64,
            u16::MAX as u64,
            zip64eocdr.disk_number_start_of_cd as u64,
        )?;
        validate_zip64_field(
            "number of entries on this disk",
            eocdr.num_of_entries_disk as u64,
            u16::MAX as u64,
            zip64eocdr.num_entries_in_directory_on_disk,
        )?;
        validate_zip64_field(
            "number of entries",
            eocdr.num_of_entries as u64,
            u16::MAX as u64,
            zip64eocdr.num_entries_in_directory,
        )?;
        validate_zip64_field(
            "central directory size",
            eocdr.size_cent_dir as u64,
            u32::MAX as u64,
            zip64eocdr.directory_size,
        )?;
        validate_zip64_field(
            "central directory offset",
            eocdr.cent_dir_offset as u64,
            u32::MAX as u64,
            zip64eocdr.offset_of_start_of_directory,
        )?;

        let mut combined = Self::from_eocdr(&eocdr);
        if eocdr.disk_num == u16::MAX {
            combined.disk_number = zip64eocdr.disk_number;
        }
        if eocdr.start_cent_dir_disk == u16::MAX {
            combined.disk_number_start_of_cd = zip64eocdr.disk_number_start_of_cd;
        }
        if eocdr.num_of_entries_disk == u16::MAX {
            combined.num_entries_in_directory_on_disk = zip64eocdr.num_entries_in_directory_on_disk;
        }
        if eocdr.num_of_entries == u16::MAX {
            combined.num_entries_in_directory = zip64eocdr.num_entries_in_directory;
        }
        if eocdr.size_cent_dir == u32::MAX {
            combined.directory_size = zip64eocdr.directory_size;
        }
        if eocdr.cent_dir_offset == u32::MAX {
            combined.offset_of_start_of_directory = zip64eocdr.offset_of_start_of_directory;
        }
        combined.version_made_by = Some(zip64eocdr.version_made_by);
        combined.version_needed_to_extract = Some(zip64eocdr.version_needed_to_extract);

        combined.validate()
    }

    /// Returns the offset of the start of the central directory in bytes.
    pub fn central_directory_offset(&self) -> u64 {
        self.offset_of_start_of_directory
    }

    /// Returns the number of entries in the central directory.
    pub fn num_entries(&self) -> u64 {
        self.num_entries_in_directory
    }

    fn from_eocdr(header: &EndOfCentralDirectoryHeader) -> Self {
        Self {
            version_made_by: None,
            version_needed_to_extract: None,
            disk_number: header.disk_num as u32,
            disk_number_start_of_cd: header.start_cent_dir_disk as u32,
            num_entries_in_directory_on_disk: header.num_of_entries_disk as u64,
            num_entries_in_directory: header.num_of_entries as u64,
            directory_size: header.size_cent_dir as u64,
            offset_of_start_of_directory: header.cent_dir_offset as u64,
            file_comment_length: header.file_comm_length,
        }
    }

    fn validate(self) -> Result<Self> {
        let minimum_directory_size = self.num_entries_in_directory.saturating_mul(MIN_CENTRAL_DIRECTORY_ENTRY_SIZE);

        if self.directory_size < minimum_directory_size {
            return Err(ZipError::InvalidCentralDirectoryEntryCount { entries: self.num_entries_in_directory });
        }

        Ok(self)
    }
}

fn validate_zip64_field(field: &'static str, legacy: u64, sentinel: u64, zip64: u64) -> Result<()> {
    if legacy != sentinel && legacy != zip64 {
        return Err(ZipError::MismatchedZip64EndOfCentralDirectoryField { field, legacy, zip64 });
    }

    Ok(())
}

// An implementation for the case of no zip64EOCDR.
impl TryFrom<&EndOfCentralDirectoryHeader> for CombinedCentralDirectoryRecord {
    type Error = ZipError;

    fn try_from(header: &EndOfCentralDirectoryHeader) -> Result<Self> {
        Self::from_eocdr(header).validate()
    }
}
