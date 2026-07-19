use std::io::Read;

use bytes::BytesMut;

use crate::{
    v2::{
        read::{
            decoder::{DecodeError, Decoder},
            Section,
        },
        Span,
    },
    DetectError, Version,
};

const DEFAULT_READ_SIZE: usize = 4 * 1024;

/// A reader which can parse a WEBC file from an arbitrary [`Read`] object.
#[derive(Debug)]
pub struct StreamingReader<R> {
    inner: R,
    buffer: BytesMut,
    decoder: Decoder,
}

impl<R: Read> StreamingReader<R> {
    pub fn new(mut reader: R) -> Result<Self, StreamingReaderError> {
        let version = crate::detect(&mut reader)?;
        if version != Version::V2 {
            return Err(StreamingReaderError::UnsupportedVersion(version));
        }

        // This is guaranteed by the webc spec.
        const BYTES_READ_BY_DETECT: usize = 8;

        Ok(StreamingReader {
            inner: reader,
            buffer: BytesMut::new(),
            decoder: Decoder::new(BYTES_READ_BY_DETECT),
        })
    }

    /// Iterate over all the sections in this WEBC file.
    pub fn sections(mut self) -> impl Iterator<Item = Result<Section, StreamingReaderError>> {
        std::iter::from_fn(move || self.next_section().transpose())
    }

    /// Iterate over all the sections in this WEBC file, and their offsets.
    pub fn sections_with_offsets(
        mut self,
    ) -> impl Iterator<Item = Result<(Section, Span), StreamingReaderError>> {
        std::iter::from_fn(move || self.next_section_with_offset().transpose())
    }

    pub fn next_section(&mut self) -> Result<Option<Section>, StreamingReaderError> {
        self.next_section_with_offset()
            .map(|section| section.map(|(s, _)| s))
    }

    fn next_section_with_offset(
        &mut self,
    ) -> Result<Option<(Section, Span)>, StreamingReaderError> {
        let mut empty_reads = 0;

        loop {
            let bytes_read = self.fill_buffer()?;
            let start = self.decoder.position();

            match self.decoder.decode(&mut self.buffer)? {
                Some(section) => {
                    let end = self.decoder.position();
                    let span = Span::new(start, end - start);
                    return Ok(Some((section, span)));
                }
                None if bytes_read == 0 => {
                    // We didn't get any new bytes and couldn't parse a section
                    // with the bytes we have at the moment. Let's try a couple
                    // more reads just in case it gives us some bytes and we
                    // can make progress.

                    if empty_reads > 3 {
                        // Looks like we tried too many times.
                        return Ok(None);
                    }

                    empty_reads += 1;
                }
                None => {
                    // We need to read another chunk
                    empty_reads = 0;
                    continue;
                }
            }
        }
    }

    fn fill_buffer(&mut self) -> Result<usize, std::io::Error> {
        let original_length = self.buffer.len();

        // Temporarily add some extra zeroes to the end that we can write to.
        //
        // Note: It'd be nice if Rust's "read_buf" feature was stable so we
        // could read into the BytesMut's uninitialized extra capacity.
        //
        // Note: We might want to do something smart with the read sizes so
        // we make bigger reads when things are progressing well, kinda like how
        // TCP scales its window size.
        self.buffer.resize(original_length + DEFAULT_READ_SIZE, 0);
        let scratch_space = self
            .buffer
            .get_mut(original_length..)
            .expect("Guaranteed by resize()");

        let bytes_read = self.inner.read(scratch_space)?;

        // make sure our buffer only contains bytes we read
        self.buffer.truncate(original_length + bytes_read);

        Ok(bytes_read)
    }
}

/// Errors that may be emitted by [`StreamingReader`].
#[derive(Debug, thiserror::Error)]
#[non_exhaustive]
pub enum StreamingReaderError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error("Unable to detect the WEBC version")]
    Detect(#[from] DetectError),
    #[error("The version, {_0}, isn't supported")]
    UnsupportedVersion(Version),
    #[error("Decode failed")]
    Decode(#[from] DecodeError),
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeMap;

    use crate::{
        metadata::Manifest,
        v2::{write::Writer, Tag},
    };

    use super::*;

    #[test]
    fn section_and_file_offsets() {
        let volume = dir_map_v2! {
            "file.txt" => b"Hello, World!",
            "another" => dir_map_v2! {
                "nested.txt" => b"nested",
            }
        };
        let atoms = BTreeMap::from([("atom".parse().unwrap(), b"some-atom".into())]);
        let mut writer = Writer::default()
            .write_manifest(&Manifest::default())
            .unwrap()
            .write_atoms(atoms)
            .unwrap();
        writer.write_volume("some-volume", volume).unwrap();
        let webc = writer.finish(crate::v2::SignatureAlgorithm::None).unwrap();

        let mut reader = StreamingReader::new(webc.as_ref()).unwrap();

        // First comes the index
        let (section, span) = reader.next_section_with_offset().unwrap().unwrap();
        assert!(matches!(section, Section::Index(_)));
        assert_eq!(span, Span::new(8, 432));
        assert_eq!(Tag::from_u8(webc[span.start]).unwrap(), Tag::Index);

        // Then the manifest
        let (section, range) = reader.next_section_with_offset().unwrap().unwrap();
        assert!(matches!(section, Section::Manifest(_)));
        assert_eq!(range, Span::new(440, 10));
        assert_eq!(Tag::from_u8(webc[range.start]).unwrap(), Tag::Manifest);

        // Next is our atoms section
        let (section, range) = reader.next_section_with_offset().unwrap().unwrap();
        let atoms = section.as_atoms().unwrap();
        assert_eq!(range, Span::new(450, 112));
        assert_eq!(Tag::from_u8(webc[range.start]).unwrap(), Tag::Atoms);
        let atom_offsets: BTreeMap<_, _> = atoms
            .iter_with_offsets()
            .map(|result| result.unwrap())
            .map(|(name, _, offset)| (name, offset))
            .collect();
        let atom_offset = atom_offsets["atom"];
        assert_eq!(atom_offset, Span::new(103, 9));
        let some_atom = atom_offset.with_offset(range.start);
        assert_eq!(std::str::from_utf8(&webc[some_atom]).unwrap(), "some-atom");

        // And finally, we get our "some-volume" volume
        let (section, range) = reader.next_section_with_offset().unwrap().unwrap();
        let volume_section = section.as_volume().unwrap();
        assert_eq!(range, Span::new(562, 252));
        assert_eq!(Tag::from_u8(webc[range.start]).unwrap(), Tag::Volume);

        // We also want to make sure the offsets for "/file.txt" are accurate
        let root = volume_section.root().unwrap();
        let entry = root.find("file.txt").unwrap().unwrap().into_file().unwrap();
        let file_txt = &webc[entry.span().with_offset(range.start)];
        assert_eq!(String::from_utf8_lossy(file_txt), "Hello, World!");
        assert_eq!(entry.checksum(), crate::utils::sha256(file_txt));

        // Check "/another/nested.txt" for good measure
        let entry = root
            .find("another")
            .unwrap()
            .unwrap()
            .into_dir()
            .unwrap()
            .find("nested.txt")
            .unwrap()
            .unwrap()
            .into_file()
            .unwrap();
        let nested_txt = &webc[entry.span().with_offset(range.start)];
        assert_eq!(String::from_utf8_lossy(nested_txt), "nested");
        assert_eq!(entry.checksum(), crate::utils::sha256(nested_txt));
    }
}
