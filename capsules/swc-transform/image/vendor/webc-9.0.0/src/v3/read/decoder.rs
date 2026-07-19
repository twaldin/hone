use bytes::{Bytes, BytesMut};

use crate::v3::{
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
        const TAG: usize = std::mem::size_of::<Tag>();
        const TAG_LEN: usize = TAG + std::mem::size_of::<u64>();
        const TAG_HASH_LEN: usize = TAG_LEN + 32;

        if src.len() < TAG {
            return Ok(None);
        }

        let mut length = [0_u8; 8];
        let &tag = src.first().expect("already checked");

        let is_index = tag == Tag::Index;

        let header_length = if is_index { TAG_LEN } else { TAG_HASH_LEN };

        if is_index {
            length.copy_from_slice(src.get(1..9).expect("already checked"));
        } else {
            length.copy_from_slice(src.get(33..41).expect("already checked"));
        }

        let mut hash = None;
        if !is_index {
            hash.get_or_insert([0; 32])
                .copy_from_slice(src.get(1..33).expect("already checked"));
        }

        let length: usize = u64::from_le_bytes(length)
            .try_into()
            .expect("Conversion never fails on 64-bit devices");

        let expected_section_size = header_length + length;

        if src.len() < expected_section_size {
            // We haven't read the entire section yet
            src.reserve(expected_section_size);
            return Ok(None);
        }

        let _header = src.split_to(header_length);

        let data = src.split_to(length).freeze();
        self.position += header_length + data.len();

        match Section::parse(tag, hash, data.clone().into()) {
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
    use crate::{metadata::Manifest, v3::Tag};

    use super::*;

    #[test]
    fn parse_a_single_section() {
        let manifest = Manifest {
            entrypoint: Some("Python".to_string()),
            ..Default::default()
        };
        let mut serialized_manifest = vec![];
        ciborium::into_writer(&manifest, &mut serialized_manifest).unwrap();
        let section = crate::v3::write::Section::new(
            Tag::Manifest,
            serialized_manifest.clone(),
            crate::v3::ChecksumAlgorithm::None,
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
        assert_eq!(decoder.position, 1 + 32 + 8 + serialized_manifest.len());
    }
}
