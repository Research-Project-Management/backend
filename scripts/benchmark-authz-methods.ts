import { performance } from 'perf_hooks';
import { Permission } from '../src/modules/project/access/enums/permission.enum';

// Generate first 54 primes for the Gödel numbering benchmark
function getPrimes(n: number): bigint[] {
  const primes: bigint[] = [];
  let candidate = 2n;
  while (primes.length < n) {
    let isPrime = true;
    for (const p of primes) {
      if (candidate % p === 0n) {
        isPrime = false;
        break;
      }
      if (p * p > candidate) break;
    }
    if (isPrime) primes.push(candidate);
    candidate++;
  }
  return primes;
}

async function runBenchmark() {
  const allPermissions = Object.values(Permission);
  const N = allPermissions.length; // 54
  console.log(`Benchmarking with ${N} distinct permissions...`);

  // 1. Array Setup
  const rolePermissionsArray: string[] = [...allPermissions];

  // 2. Set Setup
  const rolePermissionsSet: Set<string> = new Set(allPermissions);

  // 3. Bitmask Setup
  const permToBitMap = new Map<string, bigint>();
  let allBitsMask = 0n;
  allPermissions.forEach((p, idx) => {
    const bit = 1n << BigInt(idx);
    permToBitMap.set(p, bit);
    allBitsMask |= bit;
  });

  // 4. Prime Factorization Setup (Gödel Numbering)
  const primes = getPrimes(N);
  const permToPrimeMap = new Map<string, bigint>();
  let primeProduct = 1n;
  allPermissions.forEach((p, idx) => {
    const prime = primes[idx];
    permToPrimeMap.set(p, prime);
    primeProduct *= prime;
  });

  console.log(`Prime Product value: ~10^${primeProduct.toString().length} digits (${primeProduct.toString().slice(0, 30)}...)`);
  console.log(`Bitmask value (Hex): 0x${allBitsMask.toString(16)} (fits in 64 bits: ${allBitsMask <= 0xFFFFFFFFFFFFFFFFn})`);

  const ITERATIONS = 1_000_000;
  console.log(`\nRunning ${ITERATIONS.toLocaleString()} iterations for each method...\n`);

  // Test target: middle permission
  const targetPerm = allPermissions[Math.floor(N / 2)];
  const targetBit = permToBitMap.get(targetPerm)!;
  const targetPrime = permToPrimeMap.get(targetPerm)!;

  // ── 1. Array.includes ──
  const t0 = performance.now();
  let arrayFound = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    if (rolePermissionsArray.includes(targetPerm)) {
      arrayFound++;
    }
  }
  const tArray = performance.now() - t0;

  // ── 2. Set.has ──
  const t1 = performance.now();
  let setFound = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    if (rolePermissionsSet.has(targetPerm)) {
      setFound++;
    }
  }
  const tSet = performance.now() - t1;

  // ── 3. Prime Factorization (Modulo check) ──
  const t2 = performance.now();
  let primeFound = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    if (primeProduct % targetPrime === 0n) {
      primeFound++;
    }
  }
  const tPrime = performance.now() - t2;

  // ── 4. Bitmask (Bitwise AND) ──
  const t3 = performance.now();
  let bitFound = 0;
  for (let i = 0; i < ITERATIONS; i++) {
    if ((allBitsMask & targetBit) !== 0n) {
      bitFound++;
    }
  }
  const tBit = performance.now() - t3;

  // ── 5. Batch Check (All 5 permissions) ──
  const sample5 = allPermissions.slice(10, 15);
  // Bitmask batch check mask
  let sample5Mask = 0n;
  for (const p of sample5) sample5Mask |= permToBitMap.get(p)!;
  
  const t4 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    // 1 instruction batch check: all 5 present
    const allowed = (allBitsMask & sample5Mask) === sample5Mask;
  }
  const tBatchBit = performance.now() - t4;

  const t5 = performance.now();
  for (let i = 0; i < ITERATIONS; i++) {
    const allowed = sample5.every(p => rolePermissionsArray.includes(p));
  }
  const tBatchArray = performance.now() - t5;

  console.log('=== BENCHMARK RESULTS (1,000,000 Ops) ===');
  console.log(`1. Array.includes:               ${tArray.toFixed(2)} ms (${(ITERATIONS / tArray / 1000).toFixed(2)}M ops/sec)`);
  console.log(`2. Set.has:                       ${tSet.toFixed(2)} ms (${(ITERATIONS / tSet / 1000).toFixed(2)}M ops/sec)`);
  console.log(`3. Prime Modulo (U % P === 0n):  ${tPrime.toFixed(2)} ms (${(ITERATIONS / tPrime / 1000).toFixed(2)}M ops/sec)`);
  console.log(`4. Bitmask ((U & P) !== 0n):     ${tBit.toFixed(2)} ms (${(ITERATIONS / tBit / 1000).toFixed(2)}M ops/sec)`);
  console.log(`\n=== BATCH CHECK (5 Permissions) ===`);
  console.log(`- Array loop (5 x includes):     ${tBatchArray.toFixed(2)} ms`);
  console.log(`- Bitmask (1 instruction):       ${tBatchBit.toFixed(2)} ms (${(tBatchArray / tBatchBit).toFixed(1)}x faster)`);

  // Payload comparison
  const jsonPayload = JSON.stringify(rolePermissionsArray);
  const bitmaskPayload = '0x' + allBitsMask.toString(16);
  console.log(`\n=== SERIALIZATION / CACHE PAYLOAD ===`);
  console.log(`- String Array JSON size:        ${Buffer.byteLength(jsonPayload, 'utf8')} bytes`);
  console.log(`- Bitmask Hex string size:       ${Buffer.byteLength(bitmaskPayload, 'utf8')} bytes`);
  console.log(`- Payload reduction:             ${((1 - Buffer.byteLength(bitmaskPayload, 'utf8') / Buffer.byteLength(jsonPayload, 'utf8')) * 100).toFixed(1)}%`);
}

runBenchmark().catch(console.error);
