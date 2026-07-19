use st_map::StaticMap;

#[derive(StaticMap)]
pub struct Record<T> {
    pub a: T,
    pub b: T,
    pub c: T,
}
