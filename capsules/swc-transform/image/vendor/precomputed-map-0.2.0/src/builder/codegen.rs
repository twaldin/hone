use std::{ fs, fmt };
use std::io::{ self, Write };
use std::borrow::Cow;
use std::path::PathBuf;
use std::collections::HashMap;
use super::{ MapOutput, MapKind };

/// Code Generator
///
/// Generate code based on the constructed Map and the provided sequence.
pub struct CodeBuilder<'a> {
    name: String,
    hash: String,
    vis: Option<String>,
    list: Vec<OutputEntry>,
    u8seq_writer: &'a mut U8SeqWriter,
    u32seq_writer: &'a mut U32SeqWriter,
}

/// U8 seq writer
pub struct U8SeqWriter(BytesWriter);

/// U32 seq writer
pub struct U32SeqWriter(BytesWriter);

struct BytesWriter {
    entry: String,
    file: PathBuf,
    writer: Option<CountWriter<fs::File>>,
}

/// Short bytes pool
pub struct ShortPool<'s> {
    entry: String,
    buf: Vec<u8>,
    map: HashMap<Cow<'s, [u8]>, ShortId>
}

/// Short bytes Id
#[derive(Clone, Copy)]
pub struct ShortId(u32);

/// Reference Id
pub struct ReferenceId(usize);

struct OutputEntry {
    name: Option<String>,
    kind: OutputKind
}

enum OutputKind {
    Custom {
        name: String,
    },
    U8Seq {
        offset: usize,
        len: usize
    },
    BytesPositionSeq {
        offset: usize,
        len: usize,
        index: ReferenceId
    },
    BytesShortSeq {
        pooled_id: String,
        index: ReferenceId,
    },
    U32Seq {
        offset: usize,
        len: usize
    },
    List {
        item_type: String,
        value: String,
        len: usize,
        searchable: bool
    },
    Pair {
        keys: ReferenceId,
        values: ReferenceId
    },
    Tiny(ReferenceId),
    Small {
        seed: u64,
        data: ReferenceId
    },
    Medium {
        seed: u64,
        pilots: ReferenceId,
        remap: ReferenceId,
        data: ReferenceId
    }
}

struct CountWriter<W> {
    writer: W,
    count: usize
}

impl MapOutput {
    /// The seed can be saved and used in next compute to keep output stable.
    pub fn seed(&self) -> Option<u64> {
        match &self.kind {
            MapKind::Tiny => None,
            MapKind::Small(seed) => Some(*seed),
            MapKind::Medium { seed, .. } => Some(*seed)
        }
    }

    /// Generates a reordered iterator based on the constructed map.
    ///
    /// The lengths of provided lists must be equal.    
    pub fn reorder<'list: 'map, 'map, T>(&'map self, list: &'list [T])
        -> impl ExactSizeIterator<Item = &'list T> + DoubleEndedIterator + 'map
    {
        assert_eq!(self.index.len(), list.len());

        self.index.iter().map(|&idx| &list[idx])
    }

    /// Create static map
    ///
    /// # NOTE
    ///
    /// The provided data must be reordered, otherwise the behavior will be unexpected.
    pub fn create_map(&self, name: String, data: ReferenceId, builder: &mut CodeBuilder)
        -> io::Result<ReferenceId>
    {
        match &self.kind {
            MapKind::Tiny => {
                let id = builder.list.len();
                builder.list.push(OutputEntry {
                    name: Some(name),
                    kind: OutputKind::Tiny(data)
                });
                Ok(ReferenceId(id))
            },
            MapKind::Small(seed) => {
                let id = builder.list.len();
                builder.list.push(OutputEntry {
                    name: Some(name),
                    kind: OutputKind::Small { seed: *seed, data }
                });
                Ok(ReferenceId(id))                
            },
            MapKind::Medium { seed, pilots, remap } => {
                let pilots = if pilots.len() > 1024 {
                    let offset = builder.u8seq_writer.count();
                    builder.u8seq_writer.write_u8seq(pilots)?;
                    let len = builder.u8seq_writer.count() - offset;

                    let id = builder.list.len();
                    builder.list.push(OutputEntry {
                        name: None,
                        kind: OutputKind::U8Seq { offset, len }
                    });
                    ReferenceId(id)
                } else {
                    builder.create_list_raw(None, "u8".into(), false, pilots.iter().copied())?
                };

                let remap = builder.create_u32_seq_raw(None, remap.iter().copied())?;

                let id = builder.list.len();
                builder.list.push(OutputEntry {
                    name: Some(name),
                    kind: OutputKind::Medium {
                        seed: *seed,
                        pilots, remap, data
                    }
                });
                Ok(ReferenceId(id))
            },
        }
    }
}

impl<'a> CodeBuilder<'a> {
    /// Specifies the name, hash, and directory to use for the output map code.
    ///
    /// Note that `hash` must be a fully qualified type path that implements
    /// the [`HashOne`](crate::phf::HashOne) trait
    /// and is consistent with the algorithm used by MapBuilder.
    pub fn new(
        name: String,
        hash: String,
        u8seq_writer: &'a mut U8SeqWriter,
        u32seq_writer: &'a mut U32SeqWriter,
    ) -> CodeBuilder<'a> {
        CodeBuilder {
            name, hash,
            vis: None,
            list: Vec::new(),
            u8seq_writer,
            u32seq_writer,
        }
    }

    /// This will configure the generated code as `pub(vis)`.
    pub fn set_visibility(&mut self, vis: Option<String>) {
        self.vis = vis;
    }

    pub fn create_custom(&mut self, name: String) -> ReferenceId {
        let id = self.list.len();
        self.list.push(OutputEntry {
            name: None,
            kind: OutputKind::Custom { name }
        });
        ReferenceId(id)
    }

    fn create_list_raw<SEQ, T>(
        &mut self,
        name: Option<String>,
        item_type: String,
        searchable: bool,
        seq: SEQ
    )
        -> io::Result<ReferenceId>
    where
        SEQ: ExactSizeIterator<Item = T>,
        T: fmt::Display
    {
        use std::io::Write;
        
        let len = seq.len();        
        let mut s = Vec::new();
        write!(s, "&[")?;
        for t in seq {
            write!(s, "{},", t)?;
        }
        write!(s, "]")?;
        let value = String::from_utf8(s).unwrap();
        
        let id = self.list.len();
        self.list.push(OutputEntry {
            name,
            kind: OutputKind::List { item_type, len, value, searchable }
        });
        Ok(ReferenceId(id))
    }

    pub fn create_keys<SEQ, T>(&mut self, name: String, item_type: String, mapout: &MapOutput, seq: SEQ)
        -> io::Result<ReferenceId>
    where
        SEQ: Iterator<Item = T> + ExactSizeIterator,
        T: fmt::Display
    {
        self.create_list_raw(Some(name), item_type, matches!(mapout.kind, MapKind::Tiny), seq)
    }

    pub fn create_list<SEQ, T>(&mut self, name: String, item_type: String, seq: SEQ)
        -> io::Result<ReferenceId>
    where
        SEQ: Iterator<Item = T> + ExactSizeIterator,
        T: fmt::Display
    {
        self.create_list_raw(Some(name), item_type, false, seq)
    }
    
    pub fn create_pair(&mut self, keys: ReferenceId, values: ReferenceId) -> ReferenceId {
        let id = self.list.len();
        self.list.push(OutputEntry {
            name: None,
            kind: OutputKind::Pair { keys, values }
        });
        ReferenceId(id)
    }

    pub fn create_bytes_keys<SEQ, B>(&mut self, name: String, mapout: &MapOutput, seq: SEQ)
        -> io::Result<ReferenceId>
    where
        SEQ: Iterator<Item = B> + ExactSizeIterator,
        B: AsRef<[u8]>
    {
        if seq.len() > 16 {
            self.create_bytes_position_seq(name, seq)
        } else {
            self.create_list_raw(
                Some(name),
                "&'static [u8]".into(),
                matches!(mapout.kind, MapKind::Tiny),
                seq.map(|b| format!("&{:?}", b.as_ref()))
            )
        }
    }

    pub fn create_bytes_position_seq<SEQ, B>(&mut self, name: String, seq: SEQ)
        -> io::Result<ReferenceId>
    where
        SEQ: Iterator<Item = B> + ExactSizeIterator,
        B: AsRef<[u8]>
    {
        let offset = self.u8seq_writer.count();
        let mut count = 0;
        let mut list = Vec::new();
        for buf in seq {
            let buf = buf.as_ref();
            self.u8seq_writer.write_u8seq(buf)?;

            let len: u32 = buf.len().try_into().unwrap();
            count += len;
            list.push(count);
        }
        let len = self.u8seq_writer.count() - offset;
        let index = self.create_u32_seq_raw(None, list.iter().copied())?;

        let id = self.list.len();
        self.list.push(OutputEntry {
            name: Some(name),
            kind: OutputKind::BytesPositionSeq { offset, len, index }
        });
        Ok(ReferenceId(id))
    }

    fn create_u32_seq_raw<SEQ>(&mut self, name: Option<String>, seq: SEQ)
        -> io::Result<ReferenceId>
    where
        SEQ: Iterator<Item = u32> + ExactSizeIterator
    {
        if seq.len() > 1024 {
            let offset = self.u32seq_writer.count();
            for n in seq {
                self.u32seq_writer.write_u32(n)?;
            }
            let len = self.u32seq_writer.count() - offset;

            let id = self.list.len();
            self.list.push(OutputEntry {
                name,
                kind: OutputKind::U32Seq { offset, len }
            });
            Ok(ReferenceId(id))
        } else {
            self.create_list_raw(name, "u32".into(), false, seq)
        }        
    }    

    pub fn create_u32_seq<SEQ>(&mut self, name: String, seq: SEQ)
        -> io::Result<ReferenceId>
    where
        SEQ: Iterator<Item = u32> + ExactSizeIterator
    {
        self.create_u32_seq_raw(Some(name), seq)
    }

    pub fn create_short_id_seq<SEQ>(&mut self, name: String, pool: &ShortPool<'_>, seq: SEQ)
        -> io::Result<ReferenceId>
    where
        SEQ: Iterator<Item = ShortId> + ExactSizeIterator
    {
        let index = self.create_u32_seq_raw(None, seq.map(|id| id.0))?;
        let id = self.list.len();
        self.list.push(OutputEntry {
            name: Some(name),
            kind: OutputKind::BytesShortSeq {
                pooled_id: pool.entry.clone(), index
            }
        });
        Ok(ReferenceId(id))
    }

    pub fn codegen(self, writer: &mut dyn io::Write) -> io::Result<()> {
        struct ReferenceEntry {
            name: String,
        }

        let crate_name = env!("CARGO_CRATE_NAME");
        let vis = self.vis.as_deref()
            .map(|vis| format!("pub({}) ", vis))
            .unwrap_or_default();
        let u8seq_name = self.u8seq_writer.0.entry.clone();
        let u32seq_name = self.u32seq_writer.0.entry.clone();        

        let mut list: Vec<ReferenceEntry> = Vec::with_capacity(self.list.len());

        for (idx, entry) in self.list.iter().enumerate() {
            let entry = match &entry.kind {
                OutputKind::Custom { name } => ReferenceEntry {
                    name: name.clone(),
                },
                OutputKind::U8Seq { offset, len } => {
                    let ty = format!(
                        "{crate_name}::store::SliceData<{}, {}, {}>",
                        offset,
                        len,
                        u8seq_name,
                    );

                    if let Some(entry_name) = entry.name.as_ref() {
                        writeln!(writer, "{vis}type {} = {};", entry_name, ty)?;
                        ReferenceEntry { name: entry_name.clone() }
                    } else {
                        ReferenceEntry { name: ty }
                    }
                },
                OutputKind::U32Seq { offset, len } => {
                    let data_ty = format!(
                        "{crate_name}::store::SliceData<{}, {}, {}>",
                        offset,
                        len,
                        u32seq_name,
                    );
                    let ty = format!(
                        "{crate_name}::aligned::AlignedArray<{}, u32, {}>",
                        len,
                        data_ty,
                    );

                    if let Some(entry_name) = entry.name.as_ref() {
                        writeln!(writer, "{vis}type {} = {};", entry_name, ty)?;
                        ReferenceEntry { name: entry_name.clone() }
                    } else {
                        ReferenceEntry { name: ty }
                    }
                },
                OutputKind::BytesPositionSeq { offset, len, index } => {
                    let data_ty = format!(
                        "{crate_name}::store::SliceData<{}, {}, {}>",
                        offset, len, u8seq_name
                    );
                    let ty = format!(
                        "{crate_name}::seq::PositionSeq<{}, {}>",
                        &list[index.0].name,
                        data_ty,
                    );

                    let entry_name = entry.name.as_ref().unwrap();
                    writeln!(writer, "{vis}type {} = {};", entry_name, ty)?;
                    ReferenceEntry { name: entry_name.clone() }                    
                },
                OutputKind::BytesShortSeq { pooled_id, index } => {
                    let ty = format!(
                        "{crate_name}::seq::PooledSeq<{}, {}>",
                        &list[index.0].name,
                        pooled_id
                    );

                    let entry_name = entry.name.as_ref().unwrap();
                    writeln!(writer, "{vis}type {} = {};", entry_name, ty)?;
                    ReferenceEntry { name: entry_name.clone() }
                }
                OutputKind::List { item_type, value, len, searchable } => {
                    let namebuf;
                    let entry_name = if let Some(name) = entry.name.as_ref() {
                        name
                    } else {
                        namebuf = format!("PrecomputedList{}{}", self.name, idx);
                        &namebuf
                    };
                    writeln!(
                        writer,
                        "{crate_name}::define!(const {}{}: &[{}; {}] = {});",
                        searchable.then_some("searchable ").unwrap_or_default(),
                        entry_name,
                        item_type,
                        len,
                        value
                    )?;
                    ReferenceEntry { name: entry_name.clone() }
                },
                OutputKind::Pair { keys, values } => {
                    let ty = format!(
                        "({}, {})",
                        &list[keys.0].name,
                        &list[values.0].name,
                    );
                    ReferenceEntry { name: ty }                    
                }
                OutputKind::Tiny(data) => {
                    let ty = format!(
                        "{crate_name}::TinyMap<{}>",
                        &list[data.0].name
                    );
                    let val = format!("{crate_name}::TinyMap::new()");

                    let entry_name = entry.name.as_ref().unwrap();
                    writeln!(writer, "{vis}const {}: {} = {};", entry_name, ty, val)?;
                    ReferenceEntry { name: entry_name.clone() }
                },
                OutputKind::Small { seed, data } => {
                    let ty = format!(
                        "{crate_name}::SmallMap<{}, {}>",
                        &list[data.0].name,
                        self.hash,
                    );
                    let val = format!(
                        "{crate_name}::SmallMap::new({})",
                        seed,
                    );

                    let entry_name = entry.name.as_ref().unwrap();
                    writeln!(writer, "{vis}const {}: {} = {};", entry_name, ty, val)?;
                    ReferenceEntry { name: entry_name.clone() }
                },
                OutputKind::Medium { seed, pilots, remap, data } => {
                    let ty = format!(
                        "{crate_name}::MediumMap<{}, {}, {}, {}>",
                        &list[pilots.0].name,
                        &list[remap.0].name,
                        &list[data.0].name,
                        self.hash,
                    );
                    let val = format!(
                        "{crate_name}::MediumMap::new({})",
                        seed,
                    );

                    let entry_name = entry.name.as_ref().unwrap();
                    writeln!(writer, "{vis}const {}: {} = {};", entry_name, ty, val)?;
                    ReferenceEntry { name: entry_name.clone() }
                },
            };

            list.push(entry);
        }

        Ok(())
    }
}

impl<W: io::Write> io::Write for CountWriter<W> {
    fn write(&mut self, b: &[u8]) -> io::Result<usize> {
        let n = self.writer.write(b)?;
        self.count += n;
        Ok(n)
    }

    fn write_vectored(&mut self, bufs: &[io::IoSlice<'_>]) -> io::Result<usize> {
        let n = self.writer.write_vectored(bufs)?;
        self.count += n;
        Ok(n)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.writer.flush()
    }
}

impl BytesWriter {
    fn writer(&mut self) -> io::Result<&mut CountWriter<fs::File>> {
        if self.writer.is_some() {
            Ok(self.writer.as_mut().unwrap())
        } else {
            let fd = fs::File::create_new(&self.file)?;
            Ok(self.writer.get_or_insert(CountWriter {
                writer: fd,
                count: 0
            }))
        }
    }
}

impl U8SeqWriter {
    pub fn new(entry: String, file: PathBuf) -> U8SeqWriter {
        U8SeqWriter(BytesWriter {
            entry, file,
            writer: None
        })
    }
    
    fn write_u8seq(&mut self, seq: &[u8]) -> io::Result<()> {
        self.0.writer()?.write_all(seq)
    }

    fn count(&self) -> usize {
        self.0.writer.as_ref().map(|writer| writer.count).unwrap_or_default()
    }

    pub fn codegen(self, code_writer: &mut dyn io::Write) -> io::Result<()> {
        let crate_name = env!("CARGO_CRATE_NAME");
        
        if let Some(writer) = self.0.writer.as_ref() {
            writeln!(
                code_writer,
                r#"{crate_name}::define!(const {name}: &[u8; {count}] = include "{file}");"#,
                name = self.0.entry,
                count = writer.count,
                file = self.0.file.file_name().unwrap().display()
            )?;
        }

        Ok(())
    }
}

impl U32SeqWriter {
    pub fn new(entry: String, file: PathBuf) -> U32SeqWriter {
        U32SeqWriter(BytesWriter {
            entry, file,
            writer: None
        })
    }
    
    fn write_u32(&mut self, n: u32) -> io::Result<()> {
        self.0.writer()?.write_all(&n.to_le_bytes())
    }
        
    fn count(&self) -> usize {
        self.0.writer.as_ref().map(|writer| writer.count).unwrap_or_default()
    }

    pub fn codegen(self, code_writer: &mut dyn io::Write) -> io::Result<()> {
        let crate_name = env!("CARGO_CRATE_NAME");
        
        if let Some(writer) = self.0.writer.as_ref() {
            writeln!(
                code_writer,
                r#"{crate_name}::define!(const {name}: &[u8 align u32; {count}] = include "{file}");"#,
                name = self.0.entry,
                count = writer.count,
                file = self.0.file.file_name().unwrap().display(),
            )?;
        }

        Ok(())
    }
}

impl<'s> ShortPool<'s> {
    pub fn new(entry: String) -> ShortPool<'s> {
        ShortPool {
            entry,
            buf: Vec::new(),
            map: HashMap::new()
        }
    }

    pub fn insert(&mut self, value: &'s [u8]) -> ShortId {
        self.insert_cow(value.into())
    }
    
    pub fn insert_cow(&mut self, value: Cow<'s, [u8]>) -> ShortId {
        *self.map.entry(value.clone()).or_insert_with(|| {
            let offset = self.buf.len();
            self.buf.extend_from_slice(&value);
            let len: u8 = (self.buf.len() - offset).try_into().unwrap();
            let offset: u32 = offset.try_into().unwrap();

            if offset > (1 << 24) {
                panic!("bytes pool too large");
            }

            ShortId(offset | (u32::from(len) << 24))
        })
    }

    pub fn get(&self, id: ShortId) -> &[u8] {
        let (offset, len) = crate::seq::pooled_unpack(id.0);
        &self.buf[offset..][..len]
    }

    pub fn codegen(self, builder: &mut CodeBuilder<'_>, writer: &mut dyn io::Write) -> io::Result<()> {
        if self.map.is_empty() {
            return Ok(());
        }

        let crate_name = env!("CARGO_CRATE_NAME");
        let vis = builder.vis.as_deref()
            .map(|vis| format!("pub({}) ", vis))
            .unwrap_or_default();        

        let data_offset = builder.u8seq_writer.count();
        builder.u8seq_writer.write_u8seq(&self.buf)?;
        let data_len = builder.u8seq_writer.count() - data_offset;

        writeln!(writer,
            r#"
#[derive(Clone, Copy)]
{vis}struct {name}(u32);

impl From<u32> for {name} {{
    fn from(n: u32) -> Self {{
        {name}(n)
    }}
}}

impl {crate_name}::seq::PooledId for {name} {{
    fn get(self) -> Option<&'static [u8]> {{
        use {crate_name}::store::AsData;
    
        let (offset, len) = {crate_name}::seq::pooled_unpack(self.0);
        <{crate_name}::store::SliceData<{data_offset}, {data_len}, {u8seq}>>::as_data()
            .get(offset..offset + len)
    }}
}}
            "#,
            u8seq = builder.u8seq_writer.0.entry,
            name = self.entry,
        )
    }
}
