// Copyright (c) 2021 Harry [Majored] [hello@majored.pw]
// MIT License (https://github.com/Majored/rs-async-zip/blob/main/LICENSE)

pub struct DataDescriptor {
    pub crc: u32,
    pub compressed_size: u32,
    pub uncompressed_size: u32,
}

pub struct Zip64DataDescriptor {
    pub crc: u32,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
}

pub struct CombinedDataDescriptor {
    pub crc: u32,
    pub compressed_size: u64,
    pub uncompressed_size: u64,
}

impl From<DataDescriptor> for CombinedDataDescriptor {
    fn from(descriptor: DataDescriptor) -> Self {
        CombinedDataDescriptor {
            crc: descriptor.crc,
            compressed_size: descriptor.compressed_size as u64,
            uncompressed_size: descriptor.uncompressed_size as u64,
        }
    }
}

impl From<Zip64DataDescriptor> for CombinedDataDescriptor {
    fn from(descriptor: Zip64DataDescriptor) -> Self {
        CombinedDataDescriptor {
            crc: descriptor.crc,
            compressed_size: descriptor.compressed_size,
            uncompressed_size: descriptor.uncompressed_size,
        }
    }
}
