# rect-cache-key-ts

A small TypeScript library for canonical cache keys for the zero-obstacle rectangle routing problem discussed above.

It provides:

- translation invariance
- scale invariance along the rectangle boundary
- rotation / flip invariance over the 8 dihedral symmetries
- a hard `U=0` key where every pair is treated as unique
- additional `U>0` variant keys that keep selected same-net sharing groups
- typed-array output and a fast 64-bit-style hash `(hashHi, hashLo)`

## Install

```bash
npm install
npm run build
```

## Core model

The library assumes each **pair** consists of exactly two port points.

For the raw JSON shape shown in the prompt, pairs are built by:

1. grouping points by `rootConnectionName`
2. pairing points within that name in encounter order: `(1st,2nd)`, `(3rd,4th)`, ...

So if a net name appears 4 times, that produces two same-net pairs.

If a net has an odd number of points, the builder throws.

## API

```ts
import {
  KeyComputer,
  computeBaseKey,
  computeActualNetKey,
  computeVariantKey,
  groupingToArrays,
} from "./dist/index.js";
```

### High-level helpers

- `computeBaseKey(input, options)`
- `computeActualNetKey(input, options)`
- `computeVariantKey(input, groups, options)`

### Reusable class

Use `KeyComputer` when computing many keys and you want scratch-buffer reuse.

```ts
const kc = new KeyComputer({
  binsPerSide: 16,
  ratioBucketsPerOctave: 256,
});

const problem = kc.buildProblem(rawProblem);
const canonical = kc.canonicalize(problem);

const base = kc.computeBaseKey(canonical);         // U = 0
const actual = kc.computeActualNetKey(canonical);  // actual same-net grouping
const variant = kc.computeVariantKey(canonical, [[0, 3], [4, 7]]);
```

## Output format

Every key is returned as:

```ts
interface KeyWords {
  words: Float64Array;
  hashLo: number;
  hashHi: number;
}
```

The `words` array is the canonical content key. The `(hashHi, hashLo)` pair is a fast hash for indexing; if you need collision safety, compare `words` as well.

The header layout is:

```text
[ version,
  depth,
  pairCount,
  binsPerSide,
  ratioBucketsPerOctave,
  aspectCode,
  U,
  ...canonicalPairWords,
  ...groupWords ]
```

Each canonical pair contributes 4 words:

```text
[posA, zA, posB, zB]
```

The pair list is sorted canonically after symmetry normalization.

Each `U>0` group contributes:

```text
[groupSize, pairIndex0, pairIndex1, ...]
```

## Conservative use

If you want the one-sided guarantee discussed earlier:

- keep geometry exact or nearly exact
- use `computeBaseKey()` for the hard `U=0` tier
- use `computeVariantKey()` or `enumerateVariantKeys()` only with groups that are subsets of actual nets

Then a routing cached for a harder key remains valid for an easier original problem.

Geometry quantization (`binsPerSide`, `ratioBucketsPerOctave`) is a performance / cache-density knob, but it is **not** one-sided safe in the same way net splitting is.

## Example with the prompt input

```ts
import { KeyComputer } from "./dist/index.js";

const raw = [
  {
    nodeWithPortPoints: {
      center: { x: 4.354445750000032, y: -7.699999600000035 },
      width: 2.7911084999999325,
      height: 1.950008800000008,
      portPoints: [
        {
          x: 2.9588915000000657,
          y: -8.60000200000002,
          z: 0,
          rootConnectionName: "source_net_15"
        },
        {
          x: 5.749999999999998,
          y: -6.962497600000015,
          z: 0,
          rootConnectionName: "source_net_15"
        },
        {
          x: 2.9588915000000657,
          y: -8.60000200000002,
          z: 1,
          rootConnectionName: "source_net_16"
        },
        {
          x: 3.129446150000087,
          y: -8.675004000000039,
          z: 0,
          rootConnectionName: "source_net_16"
        }
      ]
    }
  }
];

const kc = new KeyComputer({
  binsPerSide: 16,
  ratioBucketsPerOctave: 256,
});

const problem = kc.buildProblem(raw[0]);
const canonical = kc.canonicalize(problem);

const base = kc.computeBaseKey(canonical);
console.log(base.hashHi.toString(16), base.hashLo.toString(16));
console.log(Array.from(base.words));
```

## Variant enumeration

`enumerateVariantKeys()` takes profile sizes such as:

- `[2]` for `U=1, S1=2`
- `[3]` for `U=1, S1=3`
- `[2, 2]` for `U=2, S1=2, S2=2`

and returns all concrete valid groupings that are subsets of the actual nets.

```ts
const keys = kc.enumerateVariantKeys(canonical, {
  profiles: [[2], [3], [2, 2]],
  maxKeysPerProfile: 256,
});

for (const key of keys) {
  console.log(groupingToArrays(key.grouping), key.hashHi, key.hashLo);
}
```

## Notes

- Pair indices used inside `U>0` groups refer to the canonical pair order after geometry normalization.
- If multiple pairs are geometrically identical, the library stabilizes their order with net-size and original build order.
- For maximum throughput, reuse one `KeyComputer` instance across many problems.
