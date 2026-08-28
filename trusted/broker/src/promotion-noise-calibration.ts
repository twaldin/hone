import {
  DIRECT_PAIRED_DELTA_SD_ESTIMATOR,
  POOLED_SCORE_SD_ESTIMATOR,
  PROMOTION_GATE_VERSION,
  PromotionNoiseCalibration,
  type PromotionNoiseCalibration as PromotionNoiseCalibrationValue,
} from "@hone/schema";

export const CAMPAIGN_12_CALIBRATION_EVIDENCE_VERSION =
  "campaign-12-identity-matched-noise-v3" as const;
export const CAMPAIGN_12_CALIBRATED_AT = "2026-08-28T03:32:53.235Z" as const;

interface JournalCalibrationEvidence {
  capsuleId: string;
  admittedCapsuleDigest: string;
  executionImage: string;
  assetGroupId: "train";
  estimator: typeof POOLED_SCORE_SD_ESTIMATOR;
  estimatorMinRepeatsPerCoordinate: 3;
  sampleDepths: readonly number[];
  informationFreeMeasurements: number;
  coordinateGroups: number;
  pooledDegreesOfFreedom: number;
  pooledWithinCoordinateSd: number;
  noiseFloor: number;
  noiseEnvelope: number;
  informationFreePairs: number;
  informationFreePositive: number;
  observedInformationFreeMeasurements: number;
  observedCoordinateGroups: number;
  deltaDistribution: Readonly<{ min: number; p05: number; median: number; p95: number; max: number }>;
  sensitivityThresholds: Readonly<{ maxSpan: number; p99: number; threeSd: number; p95: number; twoSd: number }>;
  measurementEpochs: readonly string[];
}

/**
 * Immutable campaign-12 calibration artifact. A calibration is usable only
 * when every evaluator identity dimension matches exactly. A new capsule or
 * digest, evaluator image, asset group, or measurement epoch therefore fails
 * closed and requires a new dated evidence version.
 *
 * The absolute envelope is meaningful only while real effect sizes retain the
 * relationship to noise measured for this capsule/evaluator identity. Similar
 * null pass rates do not imply similar tolerances: biome and Floyd pass at
 * roughly 41–43%, while Floyd's absolute envelope is about 26x larger.
 */
export const CAMPAIGN_12_JOURNAL_NOISE_EVIDENCE_V2: readonly JournalCalibrationEvidence[] = [
  {
    capsuleId: "cap_c50f80b4b6f1",
    admittedCapsuleDigest: "sha256:02bfd3b55ea717eb9c42f18a203804c5f4e3276da01cb1822f96227ed500368b",
    executionImage: "hone-mutation@sha256:e43b8871710267d86f3e1118b2f9a3d8ef0ab505b14e671da9728200260dcd10",
    assetGroupId: "train",
    estimator: "pooled-within-coordinate-sd-v1",
    estimatorMinRepeatsPerCoordinate: 3,
    sampleDepths: [11, 9, 11, 6, 3, 3, 3],
    informationFreeMeasurements: 46,
    coordinateGroups: 7,
    pooledDegreesOfFreedom: 39,
    pooledWithinCoordinateSd: 0,
    noiseFloor: 0,
    noiseEnvelope: 0,
    informationFreePairs: 171,
    informationFreePositive: 0,
    observedInformationFreeMeasurements: 48,
    observedCoordinateGroups: 8,
    deltaDistribution: { min: 0, p05: 0, median: 0, p95: 0, max: 0 },
    sensitivityThresholds: { maxSpan: 0, p99: 0, threeSd: 0, p95: 0, twoSd: 0 },
    measurementEpochs: [
      "m2:02967c722a51ab1d924f9b5dfe29c3d70a302553de0977f076d0f3677996fdc9", "m2:0f27e7b45f88775f5490c0a0c86059b29a14f9b314919d314b4ce3150d7199f2", "m2:286581f87bac12f848632b9b969c3323986bcf4a9a6a4bbcec2dbb5f101938dd", "m2:35ab62c93925d696e75156143c0e045b710b430b0d2d9215486e925aba7d45e5", "m2:3c4db5020d374a23fd789e8ae8ffbc1d0ed33d8ff884017845ed9f4998f5ce2c", "m2:888ab62136e23ac6de662d33143d4dd50ed1c3fd4acaa8109b29236ba53b009c", "m2:97b25b8185401ccd7f106cf68b605c55e2ce4dab1e1a51e9d3fe09ee6c5f31a5", "m2:ac82122ea46eafc1a46d8e2e297d4e1445a7b90bc97375ca4e7b7d2ec4f6240a", "m2:c327bf23fa7991228493ae5ad21b4cf840ad5d17676a147aca53c200156ade78", "m2:c759c1edf58dd82993598e44b584056e1a494844f827b54b5b7be0f5cac757d8", "m2:efed656bac81842e17dadc3d6f3330536faef610631549b6c4d974d0029c20c2",
    ],
  },
  {
    capsuleId: "cap_21e8600c6f5a",
    admittedCapsuleDigest: "sha256:a6b9a972b45b80a95290f11863146c025241916d226965e67eac971e40e93fb6",
    executionImage: "hone-mutation@sha256:e43b8871710267d86f3e1118b2f9a3d8ef0ab505b14e671da9728200260dcd10",
    assetGroupId: "train",
    estimator: "pooled-within-coordinate-sd-v1",
    estimatorMinRepeatsPerCoordinate: 3,
    sampleDepths: [11, 5, 11, 5],
    informationFreeMeasurements: 32,
    coordinateGroups: 4,
    pooledDegreesOfFreedom: 28,
    pooledWithinCoordinateSd: 0,
    noiseFloor: 0,
    noiseEnvelope: 0,
    informationFreePairs: 130,
    informationFreePositive: 0,
    observedInformationFreeMeasurements: 32,
    observedCoordinateGroups: 4,
    deltaDistribution: { min: 0, p05: 0, median: 0, p95: 0, max: 0 },
    sensitivityThresholds: { maxSpan: 0, p99: 0, threeSd: 0, p95: 0, twoSd: 0 },
    measurementEpochs: [
      "m2:00aeb40e1179860af1757e54bb7c76a94d1be987641ed746900ae79b987a29a6", "m2:1c0b35c6066d279c3442f19e4c6837c4123571cf74294cd2025ea2a48fa994ee", "m2:29725190d36cf4c47e191e9d371ea11afd61625fdf3628f07ad15e5d268803c0", "m2:31a01ea665176b83a18c7b74f7c4dbbce735fefb4791c8e6a5e5d1822d04dfec", "m2:32d44bc11dfb6fe7507ca7698cc6bf10ea1a89992ebd2313a3c6fa2610f71bc0", "m2:77ce0440c1b5946063eabe1de401fd5d2322fcca25ad9f0ed4b2aa380567c3bc", "m2:7b6013b36985aa32c6472863f452436e2dc4988ee770c2a46c0dcbeb82415c7e", "m2:8521bf245f10949f2848c41eab49c0562fdba0ff789f1735a80a76a90a57d9ec", "m2:a20baeab6f8cf45a7f1d608e2b798ffeb7f643b7da7ce4188bcffb17958f089f", "m2:b9351b79b8ad623cd51687a37e65f2ef774432a2eccc204c8a9c1bc350da027d", "m2:ddbfebf0cecfa3d32527e2d4e80783deaa4c84b01b08e9a65463e153c3be21e6",
    ],
  },
  {
    capsuleId: "cap_63630c40b876",
    admittedCapsuleDigest: "sha256:37d10ea93836a704adcb3cde4ec4c23daaa7161598e3601bb0a632722cd5789a",
    executionImage: "hone-task@sha256:421f033a97c266279c4799f5b6f4e4b81fced0f8a9a4f1d3091a05866f217392",
    assetGroupId: "train",
    estimator: "pooled-within-coordinate-sd-v1",
    estimatorMinRepeatsPerCoordinate: 3,
    sampleDepths: [11, 6, 11],
    informationFreeMeasurements: 28,
    coordinateGroups: 3,
    pooledDegreesOfFreedom: 25,
    pooledWithinCoordinateSd: 0,
    noiseFloor: 0,
    noiseEnvelope: 0,
    informationFreePairs: 126,
    informationFreePositive: 0,
    observedInformationFreeMeasurements: 30,
    observedCoordinateGroups: 4,
    deltaDistribution: { min: 0, p05: 0, median: 0, p95: 0, max: 0 },
    sensitivityThresholds: { maxSpan: 0, p99: 0, threeSd: 0, p95: 0, twoSd: 0 },
    measurementEpochs: [
      "m2:20553cb6ae600905d820e6a490f8ed31ff9b9741c39a19ce47183c3b9b913795", "m2:251068e855c91f6b40417a847c600987b49d94f9d610d3ee0dd91e75eae346cb", "m2:426a5e5d9059daaf95722860bd253bf67c20edc8409a4c19286495552671fa2d", "m2:43b9da77ffb85a54360ab9b3f69318ba881aff879dbe70e4dbda4f5ec6fe9337", "m2:5c4ed658d7eaa40a2131ea6ec521a2a22ab8b0a03835a75313d08c59a2679115", "m2:7bbfff0df06bb19b5de063ab0c30215e2efa0de1bf7d5d01c45d35a15fdd2a62", "m2:822c11e72b78dbe4a527ef032c4addf085d49864ae057585b0e262bab916f19c", "m2:929196ee845a2dffcec04d6b35cd8a2436a375adaee94b9ebdaaa256ce8c5be6", "m2:957e13473db44988bba2b07507d3b34db88104dc660a58fb19c76c5a6bc6ec2b", "m2:9645126dd011ce8a44d25d7f0a4d20261c856b89f6c832a5170d96ae44be9a6b", "m2:d898b246169aa0bacccfddb8576af0db3ead895620b93f48c11c32a702ac19dd",
    ],
  },
  {
    capsuleId: "cap_f11c10c3fc15",
    admittedCapsuleDigest: "sha256:c4f8ce59fb6668027ff9ebc6378243173999038fe468d93f70e88c8776894531",
    executionImage: "hone-task@sha256:421f033a97c266279c4799f5b6f4e4b81fced0f8a9a4f1d3091a05866f217392",
    assetGroupId: "train",
    estimator: "pooled-within-coordinate-sd-v1",
    estimatorMinRepeatsPerCoordinate: 3,
    sampleDepths: [11, 5, 11, 6],
    informationFreeMeasurements: 33,
    coordinateGroups: 4,
    pooledDegreesOfFreedom: 29,
    pooledWithinCoordinateSd: 0.006772174832562264,
    noiseFloor: 0.02031652449768679,
    noiseEnvelope: 0.030474786746530185,
    informationFreePairs: 136,
    informationFreePositive: 59,
    observedInformationFreeMeasurements: 35,
    observedCoordinateGroups: 5,
    deltaDistribution: {
      min: -0.024302908719018967,
      p05: -0.015916651896033515,
      median: -0.0015798042815074465,
      p95: 0.015638111669119256,
      max: 0.026365621172253995,
    },
    sensitivityThresholds: {
      maxSpan: 0.026365621172253995,
      p99: 0.02221519608437477,
      threeSd: 0.02031652449768679,
      p95: 0.015638111669119256,
      twoSd: 0.013544349665124528,
    },
    measurementEpochs: [
      "m2:035cace94c862b5e9a1f637804379ac428e6a1c4ff2013624ceaf260ce9b4db7", "m2:109a4169a99ba2d27e9afcb9f655d81a8b6233e5765464a3d7613c5e07c29781", "m2:33d94f28b70ac0e89d901e6271f25c90a628798957a8699326c76011162704fc", "m2:407f920dd0c05708108f80cb86741391a28e56422de6de6a3e55edf1942354e5", "m2:5446d4f8d64c6163cdb32e28282b625bbc08127141a727ad61b60256598af436", "m2:5b3eaebe4807d6b60bfd5164fb6946ab36b80c95e759a61fe0eb5d63c4e03d98", "m2:82f7c8fbce12355810d91e3d3637439380614d5b64aedd961e27e1e7cf49953a", "m2:86a2b6d9c5134a6d5aede78b7f25692ec914079a13c98f8242810827c51f0d95", "m2:8c5fbb820badc0cceff94d8be58d6982be0c024dd65fd02c2101663ee5067026", "m2:938bf0ad03f4173edb4a91106a2d23769bd190334912e95dd3045f70929938df", "m2:d78d2aed2a39bb0e03a8fe462500a1eff76cc2cee3dc41dce4ea7fe25d8e2fee",
    ],
  },
  {
    capsuleId: "cap_23de71dd36fa",
    admittedCapsuleDigest: "sha256:4f1817c56199e53eff1dae234c20a36648f015c03447bd73f21588d157768321",
    executionImage: "hone-simdjson-parse@sha256:3a3d7c2285edd17f5f6f7b4bbd8b5ac426b88b895d38b9399ac84048943ef446",
    assetGroupId: "train",
    estimator: "pooled-within-coordinate-sd-v1",
    estimatorMinRepeatsPerCoordinate: 3,
    sampleDepths: [11, 5, 5, 3],
    informationFreeMeasurements: 24,
    coordinateGroups: 4,
    pooledDegreesOfFreedom: 20,
    pooledWithinCoordinateSd: 0.0041146505663129775,
    noiseFloor: 0.012343951698938933,
    noiseEnvelope: 0.0185159275484084,
    informationFreePairs: 78,
    informationFreePositive: 45,
    observedInformationFreeMeasurements: 24,
    observedCoordinateGroups: 4,
    deltaDistribution: {
      min: -0.01525128376058027,
      p05: -0.009219715170195635,
      median: 0.0015486310621591892,
      p95: 0.007290716296473771,
      max: 0.011785495427115378,
    },
    sensitivityThresholds: {
      maxSpan: 0.01525128376058027,
      p99: 0.010423957783717254,
      threeSd: 0.012343951698938933,
      p95: 0.007290716296473771,
      twoSd: 0.008229301132625955,
    },
    measurementEpochs: [
      "m2:0cce24c3bd76f1b2abce3669f5f4f7e459b2985c81528473b4dcff49197d2583", "m2:50a4e47018be4666356fb7abafffbea1fa68575b2774a73ba61a98d10a35c5c0", "m2:5a914fec5a9254698d9f852e429bf51e2d1aa793c2a4c11e92bd846229b5cf71", "m2:5f9bda79b2dd3d5633f93300d0a1f991c46d20cf027d62ff44e9eaf740b693a6", "m2:7fdd711f0f04bc5c154645f8c4f66658533b8a9f1b590015e149d0ba56c9efaf", "m2:8e6bfb903f6de0e025a2f35a381387e0216f1966d3ba0c8bf8381cda7824ab5d", "m2:9119a8d515641081ec04fd59e1f41a8af770e78fc78fbdffba3956367c54ae36", "m2:98e42f69e1bcf20a4a7559318d0288fd1620b9414c022e18a763921d0f0da8f9", "m2:a2063e77fabc8b86223e8aec31e9b0c424b57b6adf502168d95bf58ab7249d4a", "m2:be167a6a17b646d269c112594ba78e57606b203f75ef189875f44329fbac5061", "m2:f431130193dfb51a2957e0a36597fa9c17a62ada9300a17dd770bc32c97b9c99",
    ],
  },
  {
    capsuleId: "cap_93f9f6942024",
    admittedCapsuleDigest: "sha256:5c0b981ba12680b4efea80b69efd8300183a75fa057802372487ce147a4cd761",
    executionImage: "hone-biome-task@sha256:545f0775d78c4e956a43133e46bfd36e1cf3347dcf6dcf56956bca6131bd5107",
    assetGroupId: "train",
    estimator: "pooled-within-coordinate-sd-v1",
    estimatorMinRepeatsPerCoordinate: 3,
    sampleDepths: [11, 8, 9, 5],
    informationFreeMeasurements: 33,
    coordinateGroups: 4,
    pooledDegreesOfFreedom: 29,
    pooledWithinCoordinateSd: 0.00025465284204065944,
    noiseFloor: 0.0007639585261219784,
    noiseEnvelope: 0.0011459377891829675,
    informationFreePairs: 129,
    informationFreePositive: 53,
    observedInformationFreeMeasurements: 33,
    observedCoordinateGroups: 4,
    deltaDistribution: {
      min: -0.0010221769304390588,
      p05: -0.0007849256121481047,
      median: -0.00009622732158505454,
      p95: 0.0003873783261800073,
      max: 0.0007574700843720056,
    },
    sensitivityThresholds: {
      maxSpan: 0.0010221769304390588,
      p99: 0.00059881623306192,
      threeSd: 0.0007639585261219784,
      p95: 0.0003873783261800073,
      twoSd: 0.0005093056840813189,
    },
    measurementEpochs: [
      "m2:1461c2f0ad982eba0c189881494abc4b2a8670749106dafe834ad92797495a7a", "m2:36c1903bc4bbacff9e1220a8a51886f9261cecdbc9c6abbf603c7b499df57dd7", "m2:47fb0743e4c3da955285954eaca2ca8679415c2633d9b4568e293333aa909b8a", "m2:685f4db0f9877f33b9b26a90b6bdb3cbaa3a4c972321577df249fb7046a2423f", "m2:7e1afdcebb9b9e3cab485ffcad0db8181d8a2ec547b8e886aab078853d911b87", "m2:86e6dd35a7e488efd26fcfc38b678fe29ac4de3948002643e6495d364081471b", "m2:a341f2f4b2d013117ddbb2722aa6e9a49b34d1f45e4aa317d29e57fa3fe6ad8c", "m2:a649d5a294c77a26bc2ccab874d3ff5892d046aaec1f8b99d18e3372710437c5", "m2:b218454baa587cec749ddfbbb05086cedf5d6ea8fdce8ae2b1035cb761363c8e", "m2:be3b2ab533e8fae51a67139fcd6624e87071bda805f07fdbd8217bc8ed4d2094", "m2:c67fa40e5bde6424770fe49345a96eb0368262e312fc153b67bae2ac6aa3501b",
    ],
  },
];

export const CAMPAIGN_12_JOURNAL_OBSERVATIONS_SHA256 =
  "sha256:882d3974873ec57d500ff0831d05d0b13a522767db2a682a47ec4b994c8cf93e" as const;
export const CAMPAIGN_12_LOCAL_NULL_SOURCE_COMMIT =
  "0271c9aaff021c4101d1fe0b508576484a919240" as const;
export const CAMPAIGN_12_LOCAL_NULL_SHA256 =
  "sha256:b32d52f0c3309da6ce79b1fe23cc3141d0377c8dda6eef1ef9efcda069e1bf33" as const;

interface LocalPairedDeltaEvidence {
  capsuleId: string;
  admittedCapsuleDigest: string;
  executionImage: string;
  baselineArtifactHash: string;
  pairedDeltaTrials: 16;
  pairedDeltaDegreesOfFreedom: 15;
  pairedDeltaSd: number;
  informationFreePositive: number;
  maxObservedLocalPairDelta: number;
}

const LOCAL_PAIRED_DELTA_BY_CAPSULE: Readonly<Record<string, LocalPairedDeltaEvidence>> = {
  cap_23de71dd36fa: {
    capsuleId: "cap_23de71dd36fa",
    admittedCapsuleDigest: "sha256:4f1817c56199e53eff1dae234c20a36648f015c03447bd73f21588d157768321",
    executionImage: "hone-simdjson-parse@sha256:3a3d7c2285edd17f5f6f7b4bbd8b5ac426b88b895d38b9399ac84048943ef446",
    baselineArtifactHash: "sha256:52872355cf46e14273934d8b07d2894ad1cc3e7d9ee68d23be6bf973973b5f46",
    pairedDeltaTrials: 16,
    pairedDeltaDegreesOfFreedom: 15,
    pairedDeltaSd: 0.0054658068404987254,
    informationFreePositive: 6,
    maxObservedLocalPairDelta: 0.015091778685737411,
  },
  cap_63630c40b876: {
    capsuleId: "cap_63630c40b876",
    admittedCapsuleDigest: "sha256:37d10ea93836a704adcb3cde4ec4c23daaa7161598e3601bb0a632722cd5789a",
    executionImage: "hone-task@sha256:421f033a97c266279c4799f5b6f4e4b81fced0f8a9a4f1d3091a05866f217392",
    baselineArtifactHash: "sha256:d716f0436015fc01b6912a66a47e733b57de6bd647615fb641d2c602ee601fb9",
    pairedDeltaTrials: 16,
    pairedDeltaDegreesOfFreedom: 15,
    pairedDeltaSd: 0,
    informationFreePositive: 0,
    maxObservedLocalPairDelta: 0,
  },
  cap_93f9f6942024: {
    capsuleId: "cap_93f9f6942024",
    admittedCapsuleDigest: "sha256:5c0b981ba12680b4efea80b69efd8300183a75fa057802372487ce147a4cd761",
    executionImage: "hone-biome-task@sha256:545f0775d78c4e956a43133e46bfd36e1cf3347dcf6dcf56956bca6131bd5107",
    baselineArtifactHash: "sha256:d1dba6c4b4181d967b2c2d50fff7472260f48af2238fc4dca48b45943149bfc2",
    pairedDeltaTrials: 16,
    pairedDeltaDegreesOfFreedom: 15,
    pairedDeltaSd: 0.00023741853378906786,
    informationFreePositive: 10,
    maxObservedLocalPairDelta: 0.000420918761274508,
  },
  cap_c50f80b4b6f1: {
    capsuleId: "cap_c50f80b4b6f1",
    admittedCapsuleDigest: "sha256:02bfd3b55ea717eb9c42f18a203804c5f4e3276da01cb1822f96227ed500368b",
    executionImage: "hone-mutation@sha256:e43b8871710267d86f3e1118b2f9a3d8ef0ab505b14e671da9728200260dcd10",
    baselineArtifactHash: "sha256:3be127a293a4718274d310a9438049adfb00b63bb6fd707b40bd413f8ad8f2f6",
    pairedDeltaTrials: 16,
    pairedDeltaDegreesOfFreedom: 15,
    pairedDeltaSd: 0,
    informationFreePositive: 0,
    maxObservedLocalPairDelta: 0,
  },
  cap_f11c10c3fc15: {
    capsuleId: "cap_f11c10c3fc15",
    admittedCapsuleDigest: "sha256:c4f8ce59fb6668027ff9ebc6378243173999038fe468d93f70e88c8776894531",
    executionImage: "hone-task@sha256:421f033a97c266279c4799f5b6f4e4b81fced0f8a9a4f1d3091a05866f217392",
    baselineArtifactHash: "sha256:5b25e6289fe8aae34771ed9b10b7f80a97ea52b51567af6ede22adfc2b77eacb",
    pairedDeltaTrials: 16,
    pairedDeltaDegreesOfFreedom: 15,
    pairedDeltaSd: 0.010767197710364523,
    informationFreePositive: 7,
    maxObservedLocalPairDelta: 0.022349177958261912,
  },
};

export const CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V3 = CAMPAIGN_12_JOURNAL_NOISE_EVIDENCE_V2.map((journal) => {
  const local = LOCAL_PAIRED_DELTA_BY_CAPSULE[journal.capsuleId];
  const identityMatchedLocal =
    local !== undefined
    && local.admittedCapsuleDigest === journal.admittedCapsuleDigest
    && local.executionImage === journal.executionImage;
  const maxObservedPairDelta = journal.sensitivityThresholds.maxSpan;
  if (identityMatchedLocal) {
    const noiseFloor = (3 / Math.SQRT2) * local.pairedDeltaSd;
    return {
      ...journal,
      estimator: DIRECT_PAIRED_DELTA_SD_ESTIMATOR,
      sourceCohortSha256: [CAMPAIGN_12_JOURNAL_OBSERVATIONS_SHA256, CAMPAIGN_12_LOCAL_NULL_SHA256],
      maxObservedPairDelta,
      pairedDeltaTrials: local.pairedDeltaTrials,
      pairedDeltaDegreesOfFreedom: local.pairedDeltaDegreesOfFreedom,
      pairedDeltaSd: local.pairedDeltaSd,
      localArmBaselineHash: local.baselineArtifactHash,
      noiseFloor,
      noiseEnvelope: Math.max((4.5 / Math.SQRT2) * local.pairedDeltaSd, maxObservedPairDelta),
      journalInformationFreePairs: journal.informationFreePairs,
      journalInformationFreePositive: journal.informationFreePositive,
      informationFreePairs: local.pairedDeltaTrials,
      informationFreePositive: local.informationFreePositive,
    };
  }
  return {
    ...journal,
    estimator: POOLED_SCORE_SD_ESTIMATOR,
    sourceCohortSha256: [CAMPAIGN_12_JOURNAL_OBSERVATIONS_SHA256],
    maxObservedPairDelta,
    noiseEnvelope: Math.max(4.5 * journal.pooledWithinCoordinateSd, maxObservedPairDelta),
    journalInformationFreePairs: journal.informationFreePairs,
    journalInformationFreePositive: journal.informationFreePositive,
  };
});

export interface PromotionCalibrationIdentity {
  capsuleId: string;
  admittedCapsuleDigest: string;
  executionImage: string;
  assetGroupId: string;
  measurementEpoch: string | null;
}

export function campaign12PromotionNoiseCalibration(
  identity: PromotionCalibrationIdentity,
): PromotionNoiseCalibrationValue | null {
  const evidence = CAMPAIGN_12_PROMOTION_NOISE_CALIBRATION_V3.find((entry) =>
    entry.capsuleId === identity.capsuleId
    && entry.admittedCapsuleDigest === identity.admittedCapsuleDigest
    && entry.executionImage === identity.executionImage
    && entry.assetGroupId === identity.assetGroupId
    && identity.measurementEpoch !== null
    && entry.measurementEpochs.includes(identity.measurementEpoch)
  );
  if (evidence === undefined) return null;
  const common = {
    gateVersion: PROMOTION_GATE_VERSION,
    evidenceVersion: CAMPAIGN_12_CALIBRATION_EVIDENCE_VERSION,
    calibratedAt: CAMPAIGN_12_CALIBRATED_AT,
    capsuleId: identity.capsuleId,
    admittedCapsuleDigest: identity.admittedCapsuleDigest,
    executionImage: identity.executionImage,
    assetGroupId: identity.assetGroupId,
    measurementEpoch: identity.measurementEpoch,
    sourceCohortSha256: evidence.sourceCohortSha256,
    maxObservedPairDelta: evidence.maxObservedPairDelta,
    noiseFloor: evidence.noiseFloor,
    noiseEnvelope: evidence.noiseEnvelope,
    informationFreePairs: evidence.informationFreePairs,
    informationFreePositive: evidence.informationFreePositive,
  };
  return evidence.estimator === DIRECT_PAIRED_DELTA_SD_ESTIMATOR
    ? PromotionNoiseCalibration.parse({
        ...common,
        estimator: evidence.estimator,
        pairedDeltaTrials: evidence.pairedDeltaTrials,
        pairedDeltaDegreesOfFreedom: evidence.pairedDeltaDegreesOfFreedom,
        pairedDeltaSd: evidence.pairedDeltaSd,
        localArmBaselineHash: evidence.localArmBaselineHash,
      })
    : PromotionNoiseCalibration.parse({
        ...common,
        estimator: evidence.estimator,
        estimatorMinRepeatsPerCoordinate: evidence.estimatorMinRepeatsPerCoordinate,
        sampleDepths: evidence.sampleDepths,
        informationFreeMeasurements: evidence.informationFreeMeasurements,
        coordinateGroups: evidence.coordinateGroups,
        pooledDegreesOfFreedom: evidence.pooledDegreesOfFreedom,
        pooledWithinCoordinateSd: evidence.pooledWithinCoordinateSd,
      });
}
