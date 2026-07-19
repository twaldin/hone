/*
** Trusted benchmark harness for selected test/speedtest1.c workloads.
** The SQL corresponds to speedtest1 main tests 160, 310, 410, and 510.
*/
#include "sqlite3.h"
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define KEY_COUNT 4096

typedef struct Sha256 Sha256;
struct Sha256 {
  uint32_t state[8];
  uint64_t bitLength;
  unsigned char block[64];
  unsigned int blockLength;
};

typedef struct BenchState BenchState;
struct BenchState {
  sqlite3 *db;
  Sha256 hash;
  uint64_t resultBytes;
};

static void fail(BenchState *p, const char *zWhere){
  fprintf(stderr, "%s: %s\n", zWhere, p && p->db ? sqlite3_errmsg(p->db) : "failure");
  exit(1);
}
static uint32_t rotr32(uint32_t x, unsigned int n){
  return (x>>n) | (x<<(32-n));
}

static void sha256_transform(Sha256 *p, const unsigned char *a){
  static const uint32_t k[64] = {
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  };
  uint32_t w[64], av, bv, cv, dv, ev, fv, gv, hv;
  unsigned int i;
  for(i=0; i<16; i++){
    w[i] = ((uint32_t)a[i*4]<<24) | ((uint32_t)a[i*4+1]<<16)
         | ((uint32_t)a[i*4+2]<<8) | (uint32_t)a[i*4+3];
  }
  for(i=16; i<64; i++){
    uint32_t s0 = rotr32(w[i-15],7) ^ rotr32(w[i-15],18) ^ (w[i-15]>>3);
    uint32_t s1 = rotr32(w[i-2],17) ^ rotr32(w[i-2],19) ^ (w[i-2]>>10);
    w[i] = w[i-16] + s0 + w[i-7] + s1;
  }
  av=p->state[0]; bv=p->state[1]; cv=p->state[2]; dv=p->state[3];
  ev=p->state[4]; fv=p->state[5]; gv=p->state[6]; hv=p->state[7];
  for(i=0; i<64; i++){
    uint32_t s1 = rotr32(ev,6) ^ rotr32(ev,11) ^ rotr32(ev,25);
    uint32_t ch = (ev&fv) ^ ((~ev)&gv);
    uint32_t t1 = hv + s1 + ch + k[i] + w[i];
    uint32_t s0 = rotr32(av,2) ^ rotr32(av,13) ^ rotr32(av,22);
    uint32_t maj = (av&bv) ^ (av&cv) ^ (bv&cv);
    uint32_t t2 = s0 + maj;
    hv=gv; gv=fv; fv=ev; ev=dv+t1; dv=cv; cv=bv; bv=av; av=t1+t2;
  }
  p->state[0]+=av; p->state[1]+=bv; p->state[2]+=cv; p->state[3]+=dv;
  p->state[4]+=ev; p->state[5]+=fv; p->state[6]+=gv; p->state[7]+=hv;
}

static void sha256_init(Sha256 *p){
  static const uint32_t initial[8] = {
    0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,
    0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19
  };
  memcpy(p->state, initial, sizeof(initial));
  p->bitLength = 0;
  p->blockLength = 0;
}

static void sha256_update(Sha256 *p, const void *pData, int n){
  const unsigned char *a = (const unsigned char*)pData;
  int i;
  for(i=0; i<n; i++){
    p->block[p->blockLength++] = a[i];
    if( p->blockLength==64 ){
      sha256_transform(p, p->block);
      p->bitLength += 512;
      p->blockLength = 0;
    }
  }
}

static void sha256_final(Sha256 *p, unsigned char digest[32]){
  unsigned int i = p->blockLength;
  p->block[i++] = 0x80;
  if( i>56 ){
    while( i<64 ) p->block[i++] = 0;
    sha256_transform(p, p->block);
    i = 0;
  }
  while( i<56 ) p->block[i++] = 0;
  p->bitLength += (uint64_t)p->blockLength*8;
  for(i=0; i<8; i++) p->block[63-i] = (unsigned char)(p->bitLength>>(i*8));
  sha256_transform(p, p->block);
  for(i=0; i<8; i++){
    digest[i*4] = (unsigned char)(p->state[i]>>24);
    digest[i*4+1] = (unsigned char)(p->state[i]>>16);
    digest[i*4+2] = (unsigned char)(p->state[i]>>8);
    digest[i*4+3] = (unsigned char)p->state[i];
  }
}



static void hash_bytes(BenchState *p, const void *pData, int n){
  sha256_update(&p->hash, pData, n);
  p->resultBytes += (uint64_t)n;
}

static void hash_row(BenchState *p, sqlite3_stmt *pStmt){
  int i;
  for(i=0; i<sqlite3_column_count(pStmt); i++){
    int eType = sqlite3_column_type(pStmt, i);
    unsigned char tag = (unsigned char)eType;
    const void *pValue;
    int n;
    hash_bytes(p, &tag, 1);
    if( eType==SQLITE_NULL ) continue;
    if( eType==SQLITE_BLOB ){
      pValue = sqlite3_column_blob(pStmt, i);
      n = sqlite3_column_bytes(pStmt, i);
    }else{
      pValue = sqlite3_column_text(pStmt, i);
      n = sqlite3_column_bytes(pStmt, i);
    }
    hash_bytes(p, &n, (int)sizeof(n));
    hash_bytes(p, pValue, n);
  }
}

static void reset_stmt(BenchState *p, sqlite3_stmt *pStmt){
  int rc = sqlite3_reset(pStmt);
  if( rc!=SQLITE_OK || sqlite3_clear_bindings(pStmt)!=SQLITE_OK ) fail(p, "reset");
}

static void step_all(BenchState *p, sqlite3_stmt *pStmt){
  int rc;
  while( (rc = sqlite3_step(pStmt))==SQLITE_ROW ) hash_row(p, pStmt);
  if( rc!=SQLITE_DONE ) fail(p, "step");
}

static sqlite3_stmt *prepare(BenchState *p, const char *zSql){
  sqlite3_stmt *pStmt = 0;
  if( sqlite3_prepare_v2(p->db, zSql, -1, &pStmt, 0)!=SQLITE_OK ) fail(p, "prepare");
  return pStmt;
}

static sqlite3_int64 *load_int_keys(BenchState *p){
  sqlite3_int64 *a = sqlite3_malloc64(sizeof(*a)*KEY_COUNT);
  sqlite3_stmt *pStmt = prepare(p, "SELECT a FROM t5 ORDER BY a LIMIT 4096");
  int i = 0;
  if( !a ) fail(p, "integer key allocation");
  while( i<KEY_COUNT && sqlite3_step(pStmt)==SQLITE_ROW ) a[i++] = sqlite3_column_int64(pStmt, 0);
  if( i!=KEY_COUNT ) fail(p, "integer key fixture");
  sqlite3_finalize(pStmt);
  return a;
}

static char **load_text_keys(BenchState *p){
  char **az = sqlite3_malloc64(sizeof(*az)*KEY_COUNT);
  sqlite3_stmt *pStmt = prepare(p, "SELECT a FROM t6 ORDER BY a LIMIT 4096");
  int i = 0;
  if( !az ) fail(p, "text key allocation");
  while( i<KEY_COUNT && sqlite3_step(pStmt)==SQLITE_ROW ){
    az[i] = sqlite3_mprintf("%s", sqlite3_column_text(pStmt, 0));
    if( !az[i] ) fail(p, "text key copy");
    i++;
  }
  if( i!=KEY_COUNT ) fail(p, "text key fixture");
  sqlite3_finalize(pStmt);
  return az;
}

static void run_read(BenchState *p, sqlite3_int64 *aKey, int n){
  sqlite3_stmt *pStmt = prepare(p, "SELECT b FROM t5 WHERE a=?1");
  int i;
  for(i=0; i<1024; i++){
    sqlite3_bind_int64(pStmt, 1, aKey[(i*4051)&(KEY_COUNT-1)]);
    step_all(p, pStmt); reset_stmt(p, pStmt);
  }
  for(i=0; i<n; i++){
    sqlite3_bind_int64(pStmt, 1, aKey[(i*4051)&(KEY_COUNT-1)]);
    step_all(p, pStmt); reset_stmt(p, pStmt);
  }
  sqlite3_finalize(pStmt);
}

static void run_index(BenchState *p, char **azKey, int n){
  sqlite3_stmt *pStmt = prepare(p, "SELECT b FROM t6 WHERE a=?1");
  int i;
  for(i=0; i<1024; i++){
    sqlite3_bind_text(pStmt, 1, azKey[(i*4051)&(KEY_COUNT-1)], -1, SQLITE_STATIC);
    step_all(p, pStmt); reset_stmt(p, pStmt);
  }
  for(i=0; i<n; i++){
    sqlite3_bind_text(pStmt, 1, azKey[(i*4051)&(KEY_COUNT-1)], -1, SQLITE_STATIC);
    step_all(p, pStmt); reset_stmt(p, pStmt);
  }
  sqlite3_finalize(pStmt);
}

static void run_aggregate(BenchState *p, int n, int nRow){
  sqlite3_stmt *pStmt = prepare(p,
    "SELECT count(*), avg(b), sum(length(c)), group_concat(a) FROM z1 "
    "WHERE b BETWEEN ?1 AND ?2");
  int i;
  for(i=0; i<128; i++){
    int x = (int)(((uint64_t)i*8191u)%(uint64_t)(nRow-32)) + 1;
    sqlite3_bind_int(pStmt, 1, x); sqlite3_bind_int(pStmt, 2, x+19);
    step_all(p, pStmt); reset_stmt(p, pStmt);
  }
  for(i=0; i<n; i++){
    int x = (int)(((uint64_t)i*8191u)%(uint64_t)(nRow-32)) + 1;
    sqlite3_bind_int(pStmt, 1, x); sqlite3_bind_int(pStmt, 2, x+19);
    step_all(p, pStmt); reset_stmt(p, pStmt);
  }
  sqlite3_finalize(pStmt);
}

static void run_join(BenchState *p, int n, int nRow){
  sqlite3_stmt *pStmt = prepare(p,
    "SELECT z1.c FROM z1, z2, t3, t4 "
    "WHERE t4.a BETWEEN ?1 AND ?2 AND t3.a=t4.b "
    "AND z2.a=t3.b AND z1.c=z2.c");
  int i;
  for(i=0; i<128; i++){
    int x = (int)(((uint64_t)i*8191u)%(uint64_t)(nRow-32)) + 1;
    sqlite3_bind_int(pStmt, 1, x); sqlite3_bind_int(pStmt, 2, x+14);
    step_all(p, pStmt); reset_stmt(p, pStmt);
  }
  for(i=0; i<n; i++){
    int x = (int)(((uint64_t)i*8191u)%(uint64_t)(nRow-32)) + 1;
    sqlite3_bind_int(pStmt, 1, x); sqlite3_bind_int(pStmt, 2, x+14);
    step_all(p, pStmt); reset_stmt(p, pStmt);
  }
  sqlite3_finalize(pStmt);
}

int main(int argc, char **argv){
  BenchState s = {0};
  sqlite3_int64 *aInt = 0;
  char **azText = 0;
  sqlite3_stmt *pCount;
  const char *zWorkload;
  int nRow, i;
  unsigned char digest[32];
  if( argc!=3 ){
    fprintf(stderr, "usage: %s DATABASE WORKLOAD\n", argv[0]);
    return 2;
  }
  zWorkload = argv[2];
  if( strcmp(zWorkload, "read") && strcmp(zWorkload, "index")
   && strcmp(zWorkload, "aggregate") && strcmp(zWorkload, "join") ){
    fprintf(stderr, "unknown workload\n");
    return 2;
  }
  sha256_init(&s.hash);
  if( sqlite3_open_v2(argv[1], &s.db, SQLITE_OPEN_READONLY|SQLITE_OPEN_NOMUTEX, 0)!=SQLITE_OK ) fail(&s, "open");
  if( sqlite3_exec(s.db, "PRAGMA query_only=ON; PRAGMA temp_store=MEMORY; PRAGMA cache_size=-32768;", 0, 0, 0)!=SQLITE_OK ) fail(&s, "pragma");
  pCount = prepare(&s, "SELECT count(*) FROM z1");
  if( sqlite3_step(pCount)!=SQLITE_ROW || (nRow=sqlite3_column_int(pCount, 0))<10000 ) fail(&s, "row count");
  sqlite3_finalize(pCount);
  if( strcmp(zWorkload, "read")==0 ){
    aInt = load_int_keys(&s);
    run_read(&s, aInt, 16000);
  }else if( strcmp(zWorkload, "index")==0 ){
    azText = load_text_keys(&s);
    run_index(&s, azText, 16000);
  }else if( strcmp(zWorkload, "aggregate")==0 ){
    run_aggregate(&s, 32000, nRow);
  }else{
    run_join(&s, 16000, nRow);
  }
  sha256_final(&s.hash, digest);
  printf("ok workload=%s result=", zWorkload);
  for(i=0; i<32; i++) printf("%02x", digest[i]);
  printf(" result_bytes=%" PRIu64 "\n", s.resultBytes);
  if( azText ){
    for(i=0; i<KEY_COUNT; i++) sqlite3_free(azText[i]);
    sqlite3_free(azText);
  }
  sqlite3_free(aInt);
  if( sqlite3_close(s.db)!=SQLITE_OK ) fail(&s, "close");
  return 0;
}
