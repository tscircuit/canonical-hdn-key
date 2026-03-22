export interface Point2 {
  x: number;
  y: number;
}

export interface RawPortPoint {
  x: number;
  y: number;
  z: number;
  rootConnectionName: string;
}

export interface RawNodeWithPortPoints {
  center: Point2;
  width: number;
  height: number;
  portPoints: RawPortPoint[];
}

export interface RawProblemItem {
  nodeWithPortPoints: RawNodeWithPortPoints;
}

export interface BuildProblemOptions {
  depth?: number;
  sideEpsilon?: number;
}

export interface GeometryKeyOptions {
  binsPerSide?: number;
  ratioBucketsPerOctave?: number;
  sideEpsilon?: number;
}

export interface EnumerateVariantOptions {
  profiles: ReadonlyArray<ReadonlyArray<number>>;
  maxKeysPerProfile?: number;
}

export interface ProblemBuffers {
  width: number;
  height: number;
  depth: number;
  pairCount: number;
  netCount: number;
  t1: Float64Array;
  t2: Float64Array;
  z1: Int32Array;
  z2: Int32Array;
  netOfPair: Int32Array;
  netSizeOfPair: Int32Array;
}

export interface CanonicalGeometry {
  depth: number;
  pairCount: number;
  binsPerSide: number;
  ratioBucketsPerOctave: number;
  aspectCode: number;
  pairs: Float64Array;
  netOfCanonicalPair: Int32Array;
  netSizeOfCanonicalPair: Int32Array;
  originalPairOfCanonicalPair: Int32Array;
}

export interface KeyWords {
  words: Float64Array;
  hashLo: number;
  hashHi: number;
}

export interface VariantGrouping {
  profile: Int32Array;
  groups: Int32Array;
  groupOffsets: Int32Array;
}

export interface VariantKey extends KeyWords {
  grouping: VariantGrouping;
}

const KEY_VERSION = 1;
const DEFAULT_SIDE_EPSILON = 1e-6;
const HEADER_WORDS = 7;

function isRawProblemItem(value: RawProblemItem | RawNodeWithPortPoints): value is RawProblemItem {
  return (value as RawProblemItem).nodeWithPortPoints !== undefined;
}

function modPositive(value: number, modulus: number): number {
  let out = value % modulus;
  if (out < 0) out += modulus;
  return out;
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function lexCompareNumericSlices(
  a: ArrayLike<number>,
  aOffset: number,
  b: ArrayLike<number>,
  bOffset: number,
  words: number,
): number {
  for (let i = 0; i < words; i += 1) {
    const av = a[aOffset + i];
    const bv = b[bOffset + i];
    if (av < bv) return -1;
    if (av > bv) return 1;
  }
  return 0;
}

function lexCompareGroups(a: readonly number[], b: readonly number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return a.length - b.length;
}

function sortNumbersAscending(values: number[]): void {
  values.sort((a, b) => a - b);
}

function sortGroupsCanonical(groups: number[][]): void {
  groups.sort((a, b) => {
    if (a.length !== b.length) return b.length - a.length;
    return lexCompareGroups(a, b);
  });
}

function stablePairCompare(
  pairWords: Float64Array,
  netSizeOfPair: Int32Array,
  aIndex: number,
  bIndex: number,
): number {
  const cmp = lexCompareNumericSlices(pairWords, aIndex << 2, pairWords, bIndex << 2, 4);
  if (cmp !== 0) return cmp;

  const aNetSize = netSizeOfPair[aIndex];
  const bNetSize = netSizeOfPair[bIndex];
  if (aNetSize !== bNetSize) return bNetSize - aNetSize;

  return aIndex - bIndex;
}

function quickSortPairIndices(
  indices: Int32Array,
  pairWords: Float64Array,
  netSizeOfPair: Int32Array,
  left: number,
  right: number,
): void {
  let l = left;
  let r = right;

  while (l < r) {
    let i = l;
    let j = r;
    const pivot = indices[(l + r) >> 1];

    while (i <= j) {
      while (stablePairCompare(pairWords, netSizeOfPair, indices[i], pivot) < 0) i += 1;
      while (stablePairCompare(pairWords, netSizeOfPair, indices[j], pivot) > 0) j -= 1;
      if (i <= j) {
        const tmp = indices[i];
        indices[i] = indices[j];
        indices[j] = tmp;
        i += 1;
        j -= 1;
      }
    }

    if (j - l < r - i) {
      if (l < j) quickSortPairIndices(indices, pairWords, netSizeOfPair, l, j);
      l = i;
    } else {
      if (i < r) quickSortPairIndices(indices, pairWords, netSizeOfPair, i, r);
      r = j;
    }
  }
}

function sortPairIndices(indices: Int32Array, count: number, pairWords: Float64Array, netSizeOfPair: Int32Array): void {
  for (let i = 0; i < count; i += 1) indices[i] = i;
  if (count > 1) quickSortPairIndices(indices, pairWords, netSizeOfPair, 0, count - 1);
}

function hashWords(words: Float64Array): { hashLo: number; hashHi: number } {
  const u32 = new Uint32Array(words.buffer, words.byteOffset, words.byteLength >>> 2);
  let h1 = 2166136261 >>> 0;
  let h2 = 0x9e3779b9 >>> 0;

  for (let i = 0; i < u32.length; i += 1) {
    const value = u32[i] >>> 0;
    h1 ^= value;
    h1 = Math.imul(h1, 16777619) >>> 0;

    h2 ^= (value + 0x85ebca6b + ((h2 << 6) >>> 0) + (h2 >>> 2)) >>> 0;
    h2 = Math.imul(h2, 2246822519) >>> 0;
  }

  h1 ^= words.length >>> 0;
  h1 = Math.imul(h1, 16777619) >>> 0;
  h2 ^= (words.length * 4) >>> 0;
  h2 = Math.imul(h2, 2246822519) >>> 0;

  return { hashLo: h1 >>> 0, hashHi: h2 >>> 0 };
}

function normalizeGroupingInput(groups: ReadonlyArray<ReadonlyArray<number>>, pairCount: number): VariantGrouping {
  const used = new Int8Array(pairCount);
  const normalized: number[][] = [];

  for (let gi = 0; gi < groups.length; gi += 1) {
    const source = groups[gi];
    if (source.length < 2) {
      throw new Error(`Grouping ${gi} must contain at least two canonical pair indices.`);
    }

    const out = new Array<number>(source.length);
    for (let i = 0; i < source.length; i += 1) {
      const value = source[i];
      if (!Number.isInteger(value) || value < 0 || value >= pairCount) {
        throw new Error(`Grouping ${gi} contains out-of-range pair index ${value}.`);
      }
      out[i] = value;
    }

    sortNumbersAscending(out);
    for (let i = 1; i < out.length; i += 1) {
      if (out[i] === out[i - 1]) {
        throw new Error(`Grouping ${gi} contains duplicate pair index ${out[i]}.`);
      }
    }

    for (let i = 0; i < out.length; i += 1) {
      const pairIndex = out[i];
      if (used[pairIndex] !== 0) {
        throw new Error(`Pair index ${pairIndex} appears in more than one group.`);
      }
      used[pairIndex] = 1;
    }

    normalized.push(out);
  }

  sortGroupsCanonical(normalized);

  const offsets = new Int32Array(normalized.length + 1);
  let totalMembers = 0;
  for (let i = 0; i < normalized.length; i += 1) {
    offsets[i] = totalMembers;
    totalMembers += normalized[i].length;
  }
  offsets[normalized.length] = totalMembers;

  const groupsFlat = new Int32Array(totalMembers);
  const profile = new Int32Array(normalized.length);
  let write = 0;
  for (let gi = 0; gi < normalized.length; gi += 1) {
    const group = normalized[gi];
    profile[gi] = group.length;
    for (let i = 0; i < group.length; i += 1) groupsFlat[write++] = group[i];
  }

  return {
    profile,
    groups: groupsFlat,
    groupOffsets: offsets,
  };
}

function groupingToNestedArrays(grouping: VariantGrouping): number[][] {
  const out = new Array<number[]>(grouping.profile.length);
  for (let gi = 0; gi < grouping.profile.length; gi += 1) {
    const start = grouping.groupOffsets[gi];
    const end = grouping.groupOffsets[gi + 1];
    const group = new Array<number>(end - start);
    for (let i = start, j = 0; i < end; i += 1, j += 1) group[j] = grouping.groups[i];
    out[gi] = group;
  }
  return out;
}

function profileFromSizes(sizes: readonly number[]): Int32Array {
  const copy = new Int32Array(sizes.length);
  for (let i = 0; i < sizes.length; i += 1) copy[i] = sizes[i];
  copy.sort();
  copy.reverse();
  return copy;
}

export class KeyComputer {
  readonly binsPerSide: number;
  readonly ratioBucketsPerOctave: number;
  readonly sideEpsilon: number;

  private scratchPairWords: Float64Array = new Float64Array(0);
  private scratchSortedPairs: Float64Array = new Float64Array(0);
  private scratchIndices: Int32Array = new Int32Array(0);
  private scratchBestNet: Int32Array = new Int32Array(0);
  private scratchBestNetSize: Int32Array = new Int32Array(0);
  private scratchBestOriginalPair: Int32Array = new Int32Array(0);
  private scratchQuant1: Int32Array = new Int32Array(0);
  private scratchQuant2: Int32Array = new Int32Array(0);

  constructor(options: GeometryKeyOptions = {}) {
    this.binsPerSide = Math.max(0, options.binsPerSide ?? 0) | 0;
    this.ratioBucketsPerOctave = Math.max(0, options.ratioBucketsPerOctave ?? 0) | 0;
    this.sideEpsilon = options.sideEpsilon ?? DEFAULT_SIDE_EPSILON;
  }

  buildProblem(input: RawProblemItem | RawNodeWithPortPoints, options: BuildProblemOptions = {}): ProblemBuffers {
    const node = isRawProblemItem(input) ? input.nodeWithPortPoints : input;
    const width = node.width;
    const height = node.height;
    const halfW = width * 0.5;
    const halfH = height * 0.5;
    const left = node.center.x - halfW;
    const right = node.center.x + halfW;
    const bottom = node.center.y - halfH;
    const top = node.center.y + halfH;
    const portPoints = node.portPoints;

    if ((portPoints.length & 1) !== 0) {
      throw new Error(`Expected an even number of port points, received ${portPoints.length}.`);
    }

    const pairCount = portPoints.length >>> 1;
    const t1 = new Float64Array(pairCount);
    const t2 = new Float64Array(pairCount);
    const z1 = new Int32Array(pairCount);
    const z2 = new Int32Array(pairCount);
    const netOfPair = new Int32Array(pairCount);

    const rootToDenseNet = new Map<string, number>();
    const pendingT: number[] = [];
    const pendingZ: number[] = [];
    const pendingFlag: number[] = [];
    const pairCountByNet: number[] = [];

    let writePair = 0;
    let maxZ = 0;

    for (let i = 0; i < portPoints.length; i += 1) {
      const point = portPoints[i];
      const denseNet = internDenseNet(rootToDenseNet, point.rootConnectionName, pairCountByNet, pendingFlag, pendingT, pendingZ);
      const boundaryT = boundaryCoordinate(point.x, point.y, left, right, bottom, top, width, height, options.sideEpsilon ?? this.sideEpsilon);
      const z = point.z | 0;
      if (z > maxZ) maxZ = z;

      if (pendingFlag[denseNet] === 1) {
        t1[writePair] = pendingT[denseNet];
        z1[writePair] = pendingZ[denseNet] | 0;
        t2[writePair] = boundaryT;
        z2[writePair] = z;
        netOfPair[writePair] = denseNet;
        pendingFlag[denseNet] = 0;
        pairCountByNet[denseNet] = (pairCountByNet[denseNet] | 0) + 1;
        writePair += 1;
      } else {
        pendingT[denseNet] = boundaryT;
        pendingZ[denseNet] = z;
        pendingFlag[denseNet] = 1;
      }
    }

    for (let net = 0; net < pendingFlag.length; net += 1) {
      if (pendingFlag[net] === 1) {
        throw new Error(`Net ${net} has an odd number of port points; pairing by rootConnectionName failed.`);
      }
    }

    if (writePair !== pairCount) {
      throw new Error(`Internal pairing mismatch: built ${writePair} pairs from ${portPoints.length} points.`);
    }

    const netSizeOfPair = new Int32Array(pairCount);
    for (let pair = 0; pair < pairCount; pair += 1) {
      netSizeOfPair[pair] = pairCountByNet[netOfPair[pair]] | 0;
    }

    return {
      width,
      height,
      depth: options.depth ?? (maxZ + 1),
      pairCount,
      netCount: rootToDenseNet.size,
      t1,
      t2,
      z1,
      z2,
      netOfPair,
      netSizeOfPair,
    };
  }

  buildProblems(inputs: ReadonlyArray<RawProblemItem | RawNodeWithPortPoints>, options: BuildProblemOptions = {}): ProblemBuffers[] {
    const out = new Array<ProblemBuffers>(inputs.length);
    for (let i = 0; i < inputs.length; i += 1) out[i] = this.buildProblem(inputs[i], options);
    return out;
  }

  canonicalize(problem: ProblemBuffers): CanonicalGeometry {
    const pairCount = problem.pairCount;
    this.ensureCapacity(pairCount);

    const candidateWords = this.scratchPairWords;
    const bestWords = this.scratchSortedPairs;
    const indices = this.scratchIndices;
    const bestNet = this.scratchBestNet;
    const bestNetSize = this.scratchBestNetSize;
    const bestOriginalPair = this.scratchBestOriginalPair;

    const binsPerSide = this.binsPerSide;
    const ratioBucketsPerOctave = this.ratioBucketsPerOctave;
    const aspect = aspectCode(problem.width, problem.height, ratioBucketsPerOctave);

    if (binsPerSide > 0) {
      const quant1 = this.scratchQuant1;
      const quant2 = this.scratchQuant2;
      const modulus = binsPerSide * 4;
      for (let i = 0; i < pairCount; i += 1) {
        quant1[i] = quantizeBoundary(problem.t1[i], binsPerSide, modulus);
        quant2[i] = quantizeBoundary(problem.t2[i], binsPerSide, modulus);
      }

      let hasBest = false;
      for (let mirror = 0; mirror < 2; mirror += 1) {
        for (let rotation = 0; rotation < 4; rotation += 1) {
          const shift = rotation * binsPerSide;
          for (let pair = 0; pair < pairCount; pair += 1) {
            let a = quant1[pair];
            let b = quant2[pair];
            if (mirror === 0) {
              a = modPositive(a + shift, modulus);
              b = modPositive(b + shift, modulus);
            } else {
              a = modPositive(shift - a, modulus);
              b = modPositive(shift - b, modulus);
            }

            const wordOffset = pair << 2;
            const za = problem.z1[pair];
            const zb = problem.z2[pair];
            if (a < b || (a === b && za <= zb)) {
              candidateWords[wordOffset] = a;
              candidateWords[wordOffset + 1] = za;
              candidateWords[wordOffset + 2] = b;
              candidateWords[wordOffset + 3] = zb;
            } else {
              candidateWords[wordOffset] = b;
              candidateWords[wordOffset + 1] = zb;
              candidateWords[wordOffset + 2] = a;
              candidateWords[wordOffset + 3] = za;
            }
          }

          sortPairIndices(indices, pairCount, candidateWords, problem.netSizeOfPair);
          if (!hasBest || this.isCandidateBetter(indices, candidateWords, bestWords, pairCount)) {
            hasBest = true;
            copyCandidateBySortedIndex(
              indices,
              candidateWords,
              bestWords,
              bestNet,
              bestNetSize,
              bestOriginalPair,
              problem.netOfPair,
              problem.netSizeOfPair,
              pairCount,
            );
          }
        }
      }
    } else {
      let hasBest = false;
      for (let mirror = 0; mirror < 2; mirror += 1) {
        for (let rotation = 0; rotation < 4; rotation += 1) {
          const shift = rotation;
          for (let pair = 0; pair < pairCount; pair += 1) {
            const a = transformBoundary(problem.t1[pair], mirror === 1, shift);
            const b = transformBoundary(problem.t2[pair], mirror === 1, shift);
            const za = problem.z1[pair];
            const zb = problem.z2[pair];
            const wordOffset = pair << 2;
            if (a < b || (a === b && za <= zb)) {
              candidateWords[wordOffset] = a;
              candidateWords[wordOffset + 1] = za;
              candidateWords[wordOffset + 2] = b;
              candidateWords[wordOffset + 3] = zb;
            } else {
              candidateWords[wordOffset] = b;
              candidateWords[wordOffset + 1] = zb;
              candidateWords[wordOffset + 2] = a;
              candidateWords[wordOffset + 3] = za;
            }
          }

          sortPairIndices(indices, pairCount, candidateWords, problem.netSizeOfPair);
          if (!hasBest || this.isCandidateBetter(indices, candidateWords, bestWords, pairCount)) {
            hasBest = true;
            copyCandidateBySortedIndex(
              indices,
              candidateWords,
              bestWords,
              bestNet,
              bestNetSize,
              bestOriginalPair,
              problem.netOfPair,
              problem.netSizeOfPair,
              pairCount,
            );
          }
        }
      }
    }

    return {
      depth: problem.depth,
      pairCount,
      binsPerSide,
      ratioBucketsPerOctave,
      aspectCode: aspect,
      pairs: bestWords.slice(0, pairCount << 2),
      netOfCanonicalPair: bestNet.slice(0, pairCount),
      netSizeOfCanonicalPair: bestNetSize.slice(0, pairCount),
      originalPairOfCanonicalPair: bestOriginalPair.slice(0, pairCount),
    };
  }

  computeBaseKey(problemOrCanonical: ProblemBuffers | CanonicalGeometry): KeyWords {
    const canonical = isCanonical(problemOrCanonical) ? problemOrCanonical : this.canonicalize(problemOrCanonical);
    return this.buildKey(canonical, emptyGrouping());
  }

  computeActualNetKey(problemOrCanonical: ProblemBuffers | CanonicalGeometry): VariantKey {
    const canonical = isCanonical(problemOrCanonical) ? problemOrCanonical : this.canonicalize(problemOrCanonical);
    const groups = actualNetGroups(canonical.netOfCanonicalPair, canonical.pairCount);
    const grouping = normalizeGroupingInput(groups, canonical.pairCount);
    const key = this.buildKey(canonical, grouping);
    return { ...key, grouping };
  }

  computeVariantKey(
    problemOrCanonical: ProblemBuffers | CanonicalGeometry,
    groups: ReadonlyArray<ReadonlyArray<number>>,
  ): VariantKey {
    const canonical = isCanonical(problemOrCanonical) ? problemOrCanonical : this.canonicalize(problemOrCanonical);
    const grouping = normalizeGroupingInput(groups, canonical.pairCount);
    const key = this.buildKey(canonical, grouping);
    return { ...key, grouping };
  }

  enumerateVariantKeys(
    problemOrCanonical: ProblemBuffers | CanonicalGeometry,
    options: EnumerateVariantOptions,
  ): VariantKey[] {
    const canonical = isCanonical(problemOrCanonical) ? problemOrCanonical : this.canonicalize(problemOrCanonical);
    const maxKeysPerProfile = options.maxKeysPerProfile ?? 1024;
    const membersByNet = membersByNetFromCanonical(canonical.netOfCanonicalPair, canonical.pairCount);
    const out: VariantKey[] = [];

    for (let p = 0; p < options.profiles.length; p += 1) {
      const sortedProfile = Array.from(options.profiles[p]).map((x) => x | 0).filter((x) => x >= 2);
      if (sortedProfile.length === 0) continue;
      sortedProfile.sort((a, b) => b - a);
      const usedPair = new Int8Array(canonical.pairCount);
      const chosen: number[][] = [];
      let emitted = 0;

      const recurse = (groupIndex: number): void => {
        if (emitted >= maxKeysPerProfile) return;
        if (groupIndex >= sortedProfile.length) {
          const grouping = normalizeGroupingInput(chosen, canonical.pairCount);
          const key = this.buildKey(canonical, grouping);
          out.push({ ...key, grouping });
          emitted += 1;
          return;
        }

        const size = sortedProfile[groupIndex];
        const sameSizeAsPrevious = groupIndex > 0 && sortedProfile[groupIndex - 1] === size;
        const previousGroup = sameSizeAsPrevious ? chosen[groupIndex - 1] : null;

        for (let net = 0; net < membersByNet.length; net += 1) {
          const members = membersByNet[net];
          const available = filterUnusedMembers(members, usedPair);
          if (available.length < size) continue;
          chooseKFromSorted(available, size, (group) => {
            if (previousGroup !== null && lexCompareGroups(group, previousGroup) < 0) return false;
            chosen.push(group.slice());
            for (let i = 0; i < group.length; i += 1) usedPair[group[i]] = 1;
            recurse(groupIndex + 1);
            for (let i = 0; i < group.length; i += 1) usedPair[group[i]] = 0;
            chosen.pop();
            return emitted < maxKeysPerProfile;
          });
          if (emitted >= maxKeysPerProfile) break;
        }
      };

      recurse(0);
    }

    return out;
  }

  buildKey(canonical: CanonicalGeometry, grouping: VariantGrouping): KeyWords {
    const pairWords = canonical.pairs.length;
    const memberCount = grouping.groups.length;
    const totalWords = HEADER_WORDS + pairWords + grouping.profile.length + memberCount;
    const words = new Float64Array(totalWords);

    words[0] = KEY_VERSION;
    words[1] = canonical.depth;
    words[2] = canonical.pairCount;
    words[3] = canonical.binsPerSide;
    words[4] = canonical.ratioBucketsPerOctave;
    words[5] = canonical.aspectCode;
    words[6] = grouping.profile.length;
    words.set(canonical.pairs, HEADER_WORDS);

    let write = HEADER_WORDS + pairWords;
    for (let gi = 0; gi < grouping.profile.length; gi += 1) {
      const start = grouping.groupOffsets[gi];
      const end = grouping.groupOffsets[gi + 1];
      words[write++] = end - start;
      for (let i = start; i < end; i += 1) words[write++] = grouping.groups[i];
    }

    const hash = hashWords(words);
    return {
      words,
      hashLo: hash.hashLo,
      hashHi: hash.hashHi,
    };
  }

  private ensureCapacity(pairCount: number): void {
    const pairWordCount = pairCount << 2;
    if (this.scratchPairWords.length < pairWordCount) this.scratchPairWords = new Float64Array(pairWordCount);
    if (this.scratchSortedPairs.length < pairWordCount) this.scratchSortedPairs = new Float64Array(pairWordCount);
    if (this.scratchIndices.length < pairCount) this.scratchIndices = new Int32Array(pairCount);
    if (this.scratchBestNet.length < pairCount) this.scratchBestNet = new Int32Array(pairCount);
    if (this.scratchBestNetSize.length < pairCount) this.scratchBestNetSize = new Int32Array(pairCount);
    if (this.scratchBestOriginalPair.length < pairCount) this.scratchBestOriginalPair = new Int32Array(pairCount);
    if (this.scratchQuant1.length < pairCount) this.scratchQuant1 = new Int32Array(pairCount);
    if (this.scratchQuant2.length < pairCount) this.scratchQuant2 = new Int32Array(pairCount);
  }

  private isCandidateBetter(indices: Int32Array, candidateWords: Float64Array, bestWords: Float64Array, pairCount: number): boolean {
    for (let rank = 0; rank < pairCount; rank += 1) {
      const candidateOffset = indices[rank] << 2;
      const bestOffset = rank << 2;
      const cmp = lexCompareNumericSlices(candidateWords, candidateOffset, bestWords, bestOffset, 4);
      if (cmp < 0) return true;
      if (cmp > 0) return false;
    }
    return false;
  }
}

export function buildProblem(input: RawProblemItem | RawNodeWithPortPoints, options: BuildProblemOptions = {}): ProblemBuffers {
  return new KeyComputer(options).buildProblem(input, options);
}

export function buildProblems(
  inputs: ReadonlyArray<RawProblemItem | RawNodeWithPortPoints>,
  options: BuildProblemOptions = {},
): ProblemBuffers[] {
  return new KeyComputer(options).buildProblems(inputs, options);
}

export function computeBaseKey(
  input: RawProblemItem | RawNodeWithPortPoints | ProblemBuffers,
  options: GeometryKeyOptions = {},
): KeyWords {
  const kc = new KeyComputer(options);
  const problem = isProblemBuffers(input) ? input : kc.buildProblem(input, options);
  return kc.computeBaseKey(problem);
}

export function computeActualNetKey(
  input: RawProblemItem | RawNodeWithPortPoints | ProblemBuffers,
  options: GeometryKeyOptions = {},
): VariantKey {
  const kc = new KeyComputer(options);
  const problem = isProblemBuffers(input) ? input : kc.buildProblem(input, options);
  return kc.computeActualNetKey(problem);
}

export function computeVariantKey(
  input: RawProblemItem | RawNodeWithPortPoints | ProblemBuffers,
  groups: ReadonlyArray<ReadonlyArray<number>>,
  options: GeometryKeyOptions = {},
): VariantKey {
  const kc = new KeyComputer(options);
  const problem = isProblemBuffers(input) ? input : kc.buildProblem(input, options);
  return kc.computeVariantKey(problem, groups);
}

export function profileKey(profileSizes: readonly number[]): Int32Array {
  return profileFromSizes(profileSizes);
}

export function hashKeyWords(words: Float64Array): { hashLo: number; hashHi: number } {
  return hashWords(words);
}

export function groupingToArrays(grouping: VariantGrouping): number[][] {
  return groupingToNestedArrays(grouping);
}

function isProblemBuffers(value: unknown): value is ProblemBuffers {
  return typeof value === 'object' && value !== null && (value as ProblemBuffers).pairCount !== undefined && (value as ProblemBuffers).t1 instanceof Float64Array;
}

function isCanonical(value: ProblemBuffers | CanonicalGeometry): value is CanonicalGeometry {
  return (value as CanonicalGeometry).pairs instanceof Float64Array;
}

function emptyGrouping(): VariantGrouping {
  return {
    profile: new Int32Array(0),
    groups: new Int32Array(0),
    groupOffsets: new Int32Array([0]),
  };
}

function internDenseNet(
  table: Map<string, number>,
  name: string,
  pairCountByNet: number[],
  pendingFlag: number[],
  pendingT: number[],
  pendingZ: number[],
): number {
  const existing = table.get(name);
  if (existing !== undefined) return existing;
  const net = table.size;
  table.set(name, net);
  pairCountByNet[net] = 0;
  pendingFlag[net] = 0;
  pendingT[net] = 0;
  pendingZ[net] = 0;
  return net;
}

function boundaryCoordinate(
  x: number,
  y: number,
  left: number,
  right: number,
  bottom: number,
  top: number,
  width: number,
  height: number,
  epsilon: number,
): number {
  const dBottom = Math.abs(y - bottom);
  const dRight = Math.abs(x - right);
  const dTop = Math.abs(y - top);
  const dLeft = Math.abs(x - left);

  let side = 0;
  let best = dBottom;
  if (dRight < best) {
    side = 1;
    best = dRight;
  }
  if (dTop < best) {
    side = 2;
    best = dTop;
  }
  if (dLeft < best) {
    side = 3;
    best = dLeft;
  }

  const tolerance = epsilon * Math.max(width, height, 1);
  if (best > tolerance) {
    throw new Error(`Point (${x}, ${y}) is not on the rectangle border within tolerance ${tolerance}.`);
  }

  switch (side) {
    case 0:
      return clamp01((x - left) / width);
    case 1:
      return 1 + clamp01((y - bottom) / height);
    case 2:
      return 2 + clamp01((right - x) / width);
    default:
      return 3 + clamp01((top - y) / height);
  }
}

function transformBoundary(t: number, mirror: boolean, shift: number): number {
  if (!mirror) return modPositive(t + shift, 4);
  return modPositive(shift - t, 4);
}

function quantizeBoundary(t: number, binsPerSide: number, modulus: number): number {
  return modPositive(Math.round(t * binsPerSide), modulus);
}

function aspectCode(width: number, height: number, ratioBucketsPerOctave: number): number {
  const lo = Math.min(width, height);
  const hi = Math.max(width, height);
  const ratio = hi / lo;
  if (ratioBucketsPerOctave > 0) return Math.round(Math.log2(ratio) * ratioBucketsPerOctave);
  return ratio;
}

function copyCandidateBySortedIndex(
  sortedIndices: Int32Array,
  candidateWords: Float64Array,
  bestWords: Float64Array,
  bestNet: Int32Array,
  bestNetSize: Int32Array,
  bestOriginalPair: Int32Array,
  netOfPair: Int32Array,
  netSizeOfPair: Int32Array,
  pairCount: number,
): void {
  for (let rank = 0; rank < pairCount; rank += 1) {
    const pairIndex = sortedIndices[rank];
    const src = pairIndex << 2;
    const dst = rank << 2;
    bestWords[dst] = candidateWords[src];
    bestWords[dst + 1] = candidateWords[src + 1];
    bestWords[dst + 2] = candidateWords[src + 2];
    bestWords[dst + 3] = candidateWords[src + 3];
    bestNet[rank] = netOfPair[pairIndex];
    bestNetSize[rank] = netSizeOfPair[pairIndex];
    bestOriginalPair[rank] = pairIndex;
  }
}

function actualNetGroups(netOfCanonicalPair: Int32Array, pairCount: number): number[][] {
  const membersByNet = membersByNetFromCanonical(netOfCanonicalPair, pairCount);
  const groups: number[][] = [];
  for (let net = 0; net < membersByNet.length; net += 1) {
    const members = membersByNet[net];
    if (members.length >= 2) groups.push(members.slice());
  }
  sortGroupsCanonical(groups);
  return groups;
}

function membersByNetFromCanonical(netOfCanonicalPair: Int32Array, pairCount: number): number[][] {
  let maxNet = -1;
  for (let i = 0; i < pairCount; i += 1) if (netOfCanonicalPair[i] > maxNet) maxNet = netOfCanonicalPair[i];
  const membersByNet = new Array<number[]>(maxNet + 1);
  for (let net = 0; net <= maxNet; net += 1) membersByNet[net] = [];
  for (let pair = 0; pair < pairCount; pair += 1) membersByNet[netOfCanonicalPair[pair]].push(pair);
  return membersByNet;
}

function filterUnusedMembers(members: readonly number[], usedPair: Int8Array): number[] {
  const out: number[] = [];
  for (let i = 0; i < members.length; i += 1) {
    const pair = members[i];
    if (usedPair[pair] === 0) out.push(pair);
  }
  return out;
}

function chooseKFromSorted(source: readonly number[], k: number, visit: (group: number[]) => boolean): boolean {
  const chosen = new Array<number>(k);

  const recurse = (depth: number, start: number): boolean => {
    if (depth >= k) return visit(chosen);
    const remaining = k - depth;
    const stop = source.length - remaining;
    for (let i = start; i <= stop; i += 1) {
      chosen[depth] = source[i];
      if (!recurse(depth + 1, i + 1)) return false;
    }
    return true;
  };

  return recurse(0, 0);
}
