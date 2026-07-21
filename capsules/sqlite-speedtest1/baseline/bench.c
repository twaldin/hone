/*
** Trusted benchmark harness for one protected query-shape latency family on
** the frozen speedtest1 z1 table: a full scan ordered by c COLLATE NOCASE
** with a derived integer tie-break, forced through the external sorter by
** PRAGMA temp_store=FILE and a 64-page cache.
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

#define SORT_ITERATIONS 8

/*
** Run the protected query family SORT_ITERATIONS times per process so the
** measured latency dwarfs constant per-invocation overhead. Every iteration
** re-prepares the statement (full planner + external-sorter path) and every
** emitted row of every iteration feeds the result digest.
*/
static void run_sort(BenchState *p){
  int iter;
  for(iter=0; iter<SORT_ITERATIONS; iter++){
    sqlite3_stmt *pStmt = prepare(p,
      "SELECT a,b,c FROM z1 "
      "ORDER BY c COLLATE NOCASE, (a*3+b) DESC");
    step_all(p, pStmt);
    sqlite3_finalize(pStmt);
  }
}

int main(int argc, char **argv){
  BenchState s = {0};
  unsigned char digest[32];
  int i;
  if( argc!=3 || strcmp(argv[2], "sort")!=0 ){
    fprintf(stderr, "usage: %s DATABASE sort\n", argv[0]);
    return 2;
  }
  sha256_init(&s.hash);
  if( sqlite3_open_v2(argv[1], &s.db, SQLITE_OPEN_READONLY|SQLITE_OPEN_NOMUTEX, 0)!=SQLITE_OK ) fail(&s, "open");
  if( sqlite3_exec(s.db,
        "PRAGMA query_only=ON; PRAGMA temp_store=FILE; PRAGMA cache_size=64;",
        0, 0, 0)!=SQLITE_OK ) fail(&s, "pragma");
  run_sort(&s);
  sha256_final(&s.hash, digest);
  printf("ok workload=sort result=");
  for(i=0; i<32; i++) printf("%02x", digest[i]);
  printf(" result_bytes=%" PRIu64 "\n", s.resultBytes);
  if( sqlite3_close(s.db)!=SQLITE_OK ) fail(&s, "close");
  return 0;
}
