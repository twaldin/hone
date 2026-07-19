use bytes::{Bytes, BytesMut};

use crate::v2::{
    read::{Section, SectionError},
    Tag,
};

#[derive(Debug, Default, Clone)]
pub(crate) struct Decoder {
    position: usize,
}

impl Decoder {
    pub(crate) fn new(position: usize) -> Self {
        Decoder { position }
    }

    pub(crate) fn position(&self) -> usize {
        self.position
    }

    pub(crate) fn decode(&mut self, src: &mut BytesMut) -> Result<Option<Section>, DecodeError> {
        const HEADER_SIZE: usize = std::mem::size_of::<Tag>() + std::mem::size_of::<u64>();

        if src.len() < HEADER_SIZE {
            return Ok(None);
        }

        let mut length = [0_u8; 8];
        let &tag = src.first().expect("already checked");
        length.copy_from_slice(src.get(1..9).expect("already checked"));

        let length: usize = u64::from_le_bytes(length)
            .try_into()
            .expect("Conversion never fails on 64-bit devices");

        let expected_section_size = HEADER_SIZE + length;

        if src.len() < expected_section_size {
            // We haven't read the entire section yet
            src.reserve(expected_section_size);
            return Ok(None);
        }

        let _header = src.split_to(HEADER_SIZE);
        let data = src.split_to(length).freeze();
        self.position += HEADER_SIZE + data.len();

        match Section::parse(tag, data.clone().into()) {
            Ok(s) => Ok(Some(s)),
            Err(error) => Err(DecodeError { error, tag, data }),
        }
    }
}

#[derive(Debug, thiserror::Error)]
#[error("Unable to parse the {} section", Tag::display(*tag))]
pub struct DecodeError {
    /// The underlying error.
    #[source]
    pub error: SectionError,
    /// The section's tag.
    pub tag: u8,
    /// The section's contents.
    pub data: Bytes,
}

#[cfg(test)]
mod tests {
    use crate::{metadata::Manifest, v2::Tag};

    use super::*;

    #[test]
    fn parse_a_single_section() {
        let manifest = Manifest {
            entrypoint: Some("Python".to_string()),
            ..Default::default()
        };
        let mut serialized_manifest = vec![];
        ciborium::into_writer(&manifest, &mut serialized_manifest).unwrap();
        let section = crate::v2::write::Section::new(
            Tag::Manifest,
            serialized_manifest.clone(),
            crate::v2::ChecksumAlgorithm::None,
        );
        let mut buffer = BytesMut::new();
        section.write_to(&mut buffer);
        let mut decoder = Decoder::default();

        let decoded = decoder.decode(&mut buffer).unwrap().unwrap();

        assert!(buffer.is_empty());
        let reader = match decoded {
            Section::Manifest(r) => r,
            _ => unreachable!(),
        };
        assert_eq!(reader.bytes().as_slice(), &serialized_manifest);
        assert_eq!(decoder.position, 1 + 8 + serialized_manifest.len());
    }
}
