/**
 * Authoritative pinned manifest & CN-resilient mirror/URL helpers for `kokoro-v1.1-zh`
 * (`TTS_V2_SPEC.md` §3, `kokoro-manifest.json`).
 */
import type { ModelDownloadSource, SpeechModelId, SpeechModelVariant, Voice } from '../../types.js';

export interface KokoroManifestFile {
  readonly path: string;
  readonly size: number;
  readonly sha256: string;
}

export interface ResolvedKokoroDownloadFile extends KokoroManifestFile {
  readonly repo: string;
  readonly revision: string;
}

export interface KokoroManifest {
  readonly schema: 1;
  readonly modelId: SpeechModelId;
  readonly generatedAt: string;
  readonly onnx: {
    readonly repo: string;
    readonly revision: string;
    readonly models: {
      readonly q8: KokoroManifestFile;
      readonly fp32: KokoroManifestFile;
    };
    readonly voices: readonly KokoroManifestFile[];
  };
  readonly coreml: {
    readonly repo: string;
    readonly revision: string;
    readonly stages: readonly string[];
    readonly files: readonly KokoroManifestFile[];
  };
}

export const KOKORO_MODEL_ID: SpeechModelId = 'kokoro-v1.1-zh';

export const KOKORO_VOICE_BIN_BYTES = 522_240;
export const KOKORO_VOICE_ROWS = 510;
export const KOKORO_VOICE_DIM = 256;
export const KOKORO_SAMPLE_RATE = 24_000;
export const KOKORO_SAMPLES_PER_FRAME = 600; // 25 ms @ 24 kHz

export const KOKORO_DEFAULT_VOICES: readonly string[] = [
  'zf_018',
  'zf_004',
  'zf_028',
  'zf_001',
  'zm_010',
  'zm_029',
  'af_maple',
  'af_sol',
  'bf_vale',
];

export const KOKORO_CURATED_VOICES: readonly string[] = [
  'zf_018',
  'zf_004',
  'zf_028',
  'zf_001',
  'zm_010',
  'zm_029',
  'af_maple',
  'af_sol',
  'bf_vale',
];

export const HF_OFFICIAL_BASE = 'https://huggingface.co';
export const HF_MIRROR_BASE = 'https://hf-mirror.com';

export const DEFAULT_ALLOWED_MODEL_HOSTS: readonly string[] = [
  'huggingface.co',
  'hf-mirror.com',
  '.hf.co',
  '.huggingface.co',
  '.hf-mirror.com',
];

const CN_TIMEZONES = new Set([
  'Asia/Shanghai',
  'Asia/Chongqing',
  'Asia/Harbin',
  'Asia/Urumqi',
  'Asia/Kashgar',
  'PRC',
]);

export const KOKORO_MANIFEST: KokoroManifest = {
  "schema": 1,
  "modelId": "kokoro-v1.1-zh",
  "generatedAt": "2026-11-13",
  "onnx": {
    "repo": "onnx-community/Kokoro-82M-v1.1-zh-ONNX",
    "revision": "6cc0f0d2ebe369a68b0df87c2b65c1af8c0ac3e3",
    "models": {
      "q8": {
        "path": "onnx/model_quantized.onnx",
        "size": 127356597,
        "sha256": "a39469be791eeaa3089c1ed5e58b8731d1f2462ea0e7dae2bc44388e58f973d8"
      },
      "fp32": {
        "path": "onnx/model.onnx",
        "size": 339369442,
        "sha256": "94b973941b1852754f979be5d5e20be666d5c81d9bb886b88ae1dc85c9b895ca"
      }
    },
    "voices": [
      {
        "path": "voices/af_maple.bin",
        "size": 522240,
        "sha256": "bd5b230b916ea98c67a3a7a833a3ce43e535ce56a81503f4166ee9390b9ddeeb"
      },
      {
        "path": "voices/af_sol.bin",
        "size": 522240,
        "sha256": "87c1d6d6a3f13f89ed54a6a67cc1ff75b926aebc3a2aac3086e6dd109a8147e6"
      },
      {
        "path": "voices/bf_vale.bin",
        "size": 522240,
        "sha256": "2536f7922d31d96e994135ac2bb73f5a3c01326476200513c57d988822c6ca4d"
      },
      {
        "path": "voices/zf_001.bin",
        "size": 522240,
        "sha256": "0a89ec12bb93fb9c74077924daf02568baad64e1f869389f5aaee01a386035f8"
      },
      {
        "path": "voices/zf_002.bin",
        "size": 522240,
        "sha256": "452f96e1e3c20b14b228b5336a8d7e833b105f837d98ef53b4ddfce18eed39bf"
      },
      {
        "path": "voices/zf_003.bin",
        "size": 522240,
        "sha256": "a70654663d013a700f8afe42d57d1ce03ff49af8bdedbbb56c7e3da6e820b788"
      },
      {
        "path": "voices/zf_004.bin",
        "size": 522240,
        "sha256": "81fe28be1c496ccffa73078d5c2e6d9cc5e5f91e354d6ae0f494a9c28a42064d"
      },
      {
        "path": "voices/zf_005.bin",
        "size": 522240,
        "sha256": "a91d2c2adecbb7c191dac4fa35e213e8d370e0c733a9bf36797f513924dcb84c"
      },
      {
        "path": "voices/zf_006.bin",
        "size": 522240,
        "sha256": "52dee405a0e609d6d2869eef05984745db435a73aea49db7418494d5cb53bf9d"
      },
      {
        "path": "voices/zf_007.bin",
        "size": 522240,
        "sha256": "23b6c4312208de7f195e4e78eef0ec9e498cd52907b1678ecb7a0a1996a51573"
      },
      {
        "path": "voices/zf_008.bin",
        "size": 522240,
        "sha256": "23e20843a71fb8c5f6b984c8d4e74dd590251aeb8f620cb07a57e1485d726b0c"
      },
      {
        "path": "voices/zf_017.bin",
        "size": 522240,
        "sha256": "9c6513e77a8efb7172a4e4ebeb48b3b010152d8cd6a0f2fa1adb353248fd91ed"
      },
      {
        "path": "voices/zf_018.bin",
        "size": 522240,
        "sha256": "a9ee6566c7500ce90cbd177f1d6f6cae533356e5f0e37edf3adbd0a8f2d44020"
      },
      {
        "path": "voices/zf_019.bin",
        "size": 522240,
        "sha256": "ab5906846335ac1227c47fd04be8b7b10a47c3ee77729296cc4c0f3f8fe79073"
      },
      {
        "path": "voices/zf_021.bin",
        "size": 522240,
        "sha256": "c16f939c566f786150be3e3cb6a61f7fd8d4214a26a46d3e80e1d61de06d54ec"
      },
      {
        "path": "voices/zf_022.bin",
        "size": 522240,
        "sha256": "c1cde40b2fd522355d2ae152d06d1033b04ad3528b7273cf25dd68f28a5563db"
      },
      {
        "path": "voices/zf_023.bin",
        "size": 522240,
        "sha256": "d02846dc3b8a89b4f81634b407ce8dd30d80db40fc952d54f05853a8e26a2190"
      },
      {
        "path": "voices/zf_024.bin",
        "size": 522240,
        "sha256": "2d0f2df7b25482f6870cfbe8e83c7d1e74ed8ef8ae72df749207ea9cec7c9102"
      },
      {
        "path": "voices/zf_026.bin",
        "size": 522240,
        "sha256": "2a2434fed129796276c61947fc65bf7dadd569468ea4edaca81f3d59802bdc32"
      },
      {
        "path": "voices/zf_027.bin",
        "size": 522240,
        "sha256": "9301e7a0b80eedff7f314076e07f9eb74b687afb7fcb2c64ca94168469858aae"
      },
      {
        "path": "voices/zf_028.bin",
        "size": 522240,
        "sha256": "8d15e55ad315708010c1528c633828e3179d5cbf0bfcd2db0fec27f63001eaec"
      },
      {
        "path": "voices/zf_032.bin",
        "size": 522240,
        "sha256": "2ab0b9b1fe2f1e4cfa08b0126581df3316c12aadeadc51136c826255debd2058"
      },
      {
        "path": "voices/zf_036.bin",
        "size": 522240,
        "sha256": "b72873066ef9d57d4ea0605d32a82b2655010af51edbaecd6f926250d84efa4e"
      },
      {
        "path": "voices/zf_038.bin",
        "size": 522240,
        "sha256": "569bb54ebf05c00c89eaf56218992474a8a0494d8f94a14e933ae6a5ea9f7e31"
      },
      {
        "path": "voices/zf_039.bin",
        "size": 522240,
        "sha256": "92ad68f36d16860dcf125fdf87a4572c7ab6d7efbe6a7197d6772242a2cbbb56"
      },
      {
        "path": "voices/zf_040.bin",
        "size": 522240,
        "sha256": "bae25bd2c4dd717ce65effa2350b28a55a73f53a0bcc2cca5876a15e984eaa2d"
      },
      {
        "path": "voices/zf_042.bin",
        "size": 522240,
        "sha256": "713160091b44d962ab73e3bf66f0c2f0b9677aaf0c2f0e62faa94ed451540d1e"
      },
      {
        "path": "voices/zf_043.bin",
        "size": 522240,
        "sha256": "7d257954b651436e354712738b22e8365ed908923a5d0f154690188b2c73ea78"
      },
      {
        "path": "voices/zf_044.bin",
        "size": 522240,
        "sha256": "e166c8b2a680d3f51f1765cedc4ed7a29308ea40081b03347d5cd95f52119cc0"
      },
      {
        "path": "voices/zf_046.bin",
        "size": 522240,
        "sha256": "73e8881e76670cfe803c8ab0ccc6b5daae22efdc3a67f8e0e80658a4be21d3af"
      },
      {
        "path": "voices/zf_047.bin",
        "size": 522240,
        "sha256": "620f92a680c5a28bd8eb601738721047b73008bdf5b880f34075181afbfdcb62"
      },
      {
        "path": "voices/zf_048.bin",
        "size": 522240,
        "sha256": "24e0aa66d1cb264e86adac5ea143f7fb0a9672a8b237ba1ad017aacc1fb0290a"
      },
      {
        "path": "voices/zf_049.bin",
        "size": 522240,
        "sha256": "4808ba6dfc1c13af9921bb5072faf875b69bc54777281eb549592b1aa7e8a4bc"
      },
      {
        "path": "voices/zf_051.bin",
        "size": 522240,
        "sha256": "64df55d707d3c28dec15c5c9051653b6a6cbbbf85c52e56183d3922e53415e76"
      },
      {
        "path": "voices/zf_059.bin",
        "size": 522240,
        "sha256": "f12fd6e34f602445173f930c4f41b4d064e1a981b39b664591ad2476fb7425cc"
      },
      {
        "path": "voices/zf_060.bin",
        "size": 522240,
        "sha256": "429ad8ffb6fc8b68d3b77f2ccafba5be50e4ec31d25f890d739a16449ca01748"
      },
      {
        "path": "voices/zf_067.bin",
        "size": 522240,
        "sha256": "5669caef309a3746a47588d893d58fa61c721a94ca07e431c732ea9a2b4abc6a"
      },
      {
        "path": "voices/zf_070.bin",
        "size": 522240,
        "sha256": "f225305611865b09dc8cb36439143c02a404299b00508e00676655bb117342e2"
      },
      {
        "path": "voices/zf_071.bin",
        "size": 522240,
        "sha256": "454cd5aaa9458f3b028e973d19902a002eb59fc743eb94fb3c7c9d5d7a190a07"
      },
      {
        "path": "voices/zf_072.bin",
        "size": 522240,
        "sha256": "2274b572b44723e80eee422a914c96b37ee42bf9b5ca60e7f656bede7860a1d3"
      },
      {
        "path": "voices/zf_073.bin",
        "size": 522240,
        "sha256": "b8ecf6945ae7bb2a0353422b7af32d3b928c5fdccf3ea553bc61227a57bf4a2c"
      },
      {
        "path": "voices/zf_074.bin",
        "size": 522240,
        "sha256": "8e6726977c7494dfd567c580963630834c0971f66111e06c9467e6f7d912ea1e"
      },
      {
        "path": "voices/zf_075.bin",
        "size": 522240,
        "sha256": "84e70ca9aac5178ceaeb1eae95dd77278d71e60cfacaf9af99852922b4355560"
      },
      {
        "path": "voices/zf_076.bin",
        "size": 522240,
        "sha256": "58351a1be5aa04f874bea0e5228fc0e0047dc2ee801e915d4f59513ca60a3194"
      },
      {
        "path": "voices/zf_077.bin",
        "size": 522240,
        "sha256": "e2fd07f3b62e204cd6632696e2a975678e7e6aa5a9b2cb4927f94d875c113625"
      },
      {
        "path": "voices/zf_078.bin",
        "size": 522240,
        "sha256": "82d591700a9ecb3cb14d3d05ec5aab18bd7a482d677bf6522cf96ed4c064b23b"
      },
      {
        "path": "voices/zf_079.bin",
        "size": 522240,
        "sha256": "2df9a9fbbd39a54077a2c5073c04c7e685ce0342b34f22fc85c25a1f7a3954c7"
      },
      {
        "path": "voices/zf_083.bin",
        "size": 522240,
        "sha256": "5557cbc381e0f2cd2a29759fdda25eca664492f1cfa3fcc241e7adeaf4164661"
      },
      {
        "path": "voices/zf_084.bin",
        "size": 522240,
        "sha256": "2b2d4fdefa9a6c3d9f472d91600308be8b827a929955ec66afe81aca50c99968"
      },
      {
        "path": "voices/zf_085.bin",
        "size": 522240,
        "sha256": "2451d63f576c9ffbe91acd11f2720b6e76dc75b293d7350a9620a28c23da9ef8"
      },
      {
        "path": "voices/zf_086.bin",
        "size": 522240,
        "sha256": "c228ba018bf56d5de1339bde10dcbea7700797b85351e4d57ee5307ac7d3ee99"
      },
      {
        "path": "voices/zf_087.bin",
        "size": 522240,
        "sha256": "e0347f1430b80781d910bf1499cf64d231c34b70d6e46f30f3598254d5114d44"
      },
      {
        "path": "voices/zf_088.bin",
        "size": 522240,
        "sha256": "ee1e80cdeaffb55e1f6c41005c4966b8979b16bb808fa451739e06953d343c13"
      },
      {
        "path": "voices/zf_090.bin",
        "size": 522240,
        "sha256": "fe90b3e651c3741edf6bc08a543c531c798ec53fab1fd944ab537e9257270c68"
      },
      {
        "path": "voices/zf_092.bin",
        "size": 522240,
        "sha256": "ffd200defd2867f79886eb0e45540d53ed0dc00ceb222c5fa692f004958d3e11"
      },
      {
        "path": "voices/zf_093.bin",
        "size": 522240,
        "sha256": "d736ac1738c5ba567f8e5e9bfac8d9a774e9e3a3d001b5976a5d005c9179f811"
      },
      {
        "path": "voices/zf_094.bin",
        "size": 522240,
        "sha256": "b37b96e3c51d12f152c9476cae42396ac38cdab76f09cc935f2fbcd8fa012f42"
      },
      {
        "path": "voices/zf_099.bin",
        "size": 522240,
        "sha256": "9582b2ffb5027c695f6775161a8856108fa68530c6c1e29d2354d455d9eaa937"
      },
      {
        "path": "voices/zm_009.bin",
        "size": 522240,
        "sha256": "7b74d6ed22f201e2fa28758e78ce6197082779f2b80e69ea1bf877908609514a"
      },
      {
        "path": "voices/zm_010.bin",
        "size": 522240,
        "sha256": "73b088f7e0dc47adca4d6a642ee68843df90ff56ec2800c29d96609989d6de0a"
      },
      {
        "path": "voices/zm_011.bin",
        "size": 522240,
        "sha256": "ec4d7d934b9aa47e0e98e6ec802bb7b0a221be6f1b67d923d33b7082d9bbfe9f"
      },
      {
        "path": "voices/zm_012.bin",
        "size": 522240,
        "sha256": "50d1986f71ea1a2b3ab1bfc0c95bedc59e8de45e650bc5bde87fd99ceb83cdfb"
      },
      {
        "path": "voices/zm_013.bin",
        "size": 522240,
        "sha256": "2caa23e98910fb232a2bf6aab563666588a82bc37c99b67963ab304c5be66dff"
      },
      {
        "path": "voices/zm_014.bin",
        "size": 522240,
        "sha256": "565aa48a99d8a196ebdd1c72f4a0e5760fed65aa95992c887385d3aad9e1d2f8"
      },
      {
        "path": "voices/zm_015.bin",
        "size": 522240,
        "sha256": "e695c8d72b3eb4a864f4735db7f4f93de100ff62704e619edfddbebfafb07312"
      },
      {
        "path": "voices/zm_016.bin",
        "size": 522240,
        "sha256": "4dc408a11f1e8925ff8bca40c885e7596d08be63c2c61571234b96170f8e6d1b"
      },
      {
        "path": "voices/zm_020.bin",
        "size": 522240,
        "sha256": "2a25ca83ddfd003c0b82d97899ff38734db8faf48e5e4076d68c69aea17705c8"
      },
      {
        "path": "voices/zm_025.bin",
        "size": 522240,
        "sha256": "cbb4cd1df85b5dde4cf742c61d9b93e179574935c1162d06604bc4be6a8e990d"
      },
      {
        "path": "voices/zm_029.bin",
        "size": 522240,
        "sha256": "ff78cb9f64d43fe6179c9479257775bea94dc31eade9362b0c630749025d8ecd"
      },
      {
        "path": "voices/zm_030.bin",
        "size": 522240,
        "sha256": "32f8fe4d5f626dfb67adb73499690fd4f5952763746efbcadcf2daad4a3560a6"
      },
      {
        "path": "voices/zm_031.bin",
        "size": 522240,
        "sha256": "a5974232ed634be2ae40526101ee7c653120fdb354b1584f2bb38ed4fae4a39e"
      },
      {
        "path": "voices/zm_033.bin",
        "size": 522240,
        "sha256": "758e64c15efad492beebf575eb96951e0500da980bf5e8a3850d078d0430dda1"
      },
      {
        "path": "voices/zm_034.bin",
        "size": 522240,
        "sha256": "b371bef26b75c826de15c836103da3e037a44f605ffe744d68ad485d17e370ab"
      },
      {
        "path": "voices/zm_035.bin",
        "size": 522240,
        "sha256": "8b1c603f6e1eae300ac1a6f1199a5bb1ce9814d3e1e61f7536d21b564d680476"
      },
      {
        "path": "voices/zm_037.bin",
        "size": 522240,
        "sha256": "535ec47cb6ed66c203f61ace51eddbc7a13ecaca2458c1d8d5a928fb3db4b315"
      },
      {
        "path": "voices/zm_041.bin",
        "size": 522240,
        "sha256": "8b7bd5649a00c62e87a6099eb31d683664bfb0fd55bcd5211da62e95b3b78ffc"
      },
      {
        "path": "voices/zm_045.bin",
        "size": 522240,
        "sha256": "68d5e7f3415811a076326178c2d9f5d3aa168cf27deb6ae3f0395ab97ad45225"
      },
      {
        "path": "voices/zm_050.bin",
        "size": 522240,
        "sha256": "7869f25a5e71ea9b67a1893777e375ac411bdbfb75feff5efe25fad2fc766c8d"
      },
      {
        "path": "voices/zm_052.bin",
        "size": 522240,
        "sha256": "e775a71cd74c5462d5a6c3f0ff7681f04419053043ad2dcbabaa13d0c6de0b08"
      },
      {
        "path": "voices/zm_053.bin",
        "size": 522240,
        "sha256": "a549dcf0456b2ba1515455e0a30d111b00d24e748880e03da1965cd4ff10baf7"
      },
      {
        "path": "voices/zm_054.bin",
        "size": 522240,
        "sha256": "4f7aeb1627fa1d406bcc1a83e4eeb8b014509dca492dec0ae7dd4d0d1cdbe8b3"
      },
      {
        "path": "voices/zm_055.bin",
        "size": 522240,
        "sha256": "3cf77a37899053b5a7c224f51a22371dc37d30667d87e1b481e760ac0f8f0da8"
      },
      {
        "path": "voices/zm_056.bin",
        "size": 522240,
        "sha256": "d5f48143152f376a940182741589fb1f588387e09f1a9263760981f8702af816"
      },
      {
        "path": "voices/zm_057.bin",
        "size": 522240,
        "sha256": "29cb23f82add956f25c7b663db2027d5a50abb7035c7cb15ee608e193a412f51"
      },
      {
        "path": "voices/zm_058.bin",
        "size": 522240,
        "sha256": "0cafc2ef83710c4ce55b384107426cfdcb23aabf5699e106ff392f9571b4d4f3"
      },
      {
        "path": "voices/zm_061.bin",
        "size": 522240,
        "sha256": "d57141bd480e7a4f1a3b5d3365ce53ac04cfe6dd9d0f2d3a052213f80657046d"
      },
      {
        "path": "voices/zm_062.bin",
        "size": 522240,
        "sha256": "171d8811bfeb198714b0d3733ed740eb56be0aa3e6d2bd7b127904116a199f93"
      },
      {
        "path": "voices/zm_063.bin",
        "size": 522240,
        "sha256": "6fbe326e5852cd9dbac7eb7e9c9989a604e51074d251a8ff8365e050c83b2a6e"
      },
      {
        "path": "voices/zm_064.bin",
        "size": 522240,
        "sha256": "6e712d18758f2d8654c97fb274c23b5148dbafc1027ee6539446d4c8aff308cd"
      },
      {
        "path": "voices/zm_065.bin",
        "size": 522240,
        "sha256": "77918a32b75bf7902a6cee310cd22fb16de7ecbb9aa438a05039ebec73f9e0e8"
      },
      {
        "path": "voices/zm_066.bin",
        "size": 522240,
        "sha256": "fcdd1d4c8b2808c4456418c76ed2321910b3f1b5c2646365af4ee0e8c6c53c4d"
      },
      {
        "path": "voices/zm_068.bin",
        "size": 522240,
        "sha256": "ae265665e29656ea0d151f3315c649d892ecf053391c3c3bec5f10bf18531a58"
      },
      {
        "path": "voices/zm_069.bin",
        "size": 522240,
        "sha256": "54ac2dc25ee5d1dfa72f777ff538faf69033705019a9e15f3138deb79a965774"
      },
      {
        "path": "voices/zm_080.bin",
        "size": 522240,
        "sha256": "cbbcae6bfd6c2f3875b2163fffc8851aeae1b8bad2f1006a94ea4e6f9b44ae9e"
      },
      {
        "path": "voices/zm_081.bin",
        "size": 522240,
        "sha256": "ffc1341f044c95ad8ef598079df9e3a85d81d093268ae8422848a9b81d386fd2"
      },
      {
        "path": "voices/zm_082.bin",
        "size": 522240,
        "sha256": "7351d7652d97ec5fcb7632b317d7c4e062fff3cf4ed0246167d3d15e97046c01"
      },
      {
        "path": "voices/zm_089.bin",
        "size": 522240,
        "sha256": "f4315ceab376b4082cc9cdd8028d37f9aa7d43ad67ddb85902a247df0913ca89"
      },
      {
        "path": "voices/zm_091.bin",
        "size": 522240,
        "sha256": "6ab4a21b702ec57161f48e350de3fa0b0bd1d13a890657398cfa21452d85a9b3"
      },
      {
        "path": "voices/zm_095.bin",
        "size": 522240,
        "sha256": "4d4dac7245ea4c4c4740137fca229932055e376aed2b1ad7cd0e3e3859a13b75"
      },
      {
        "path": "voices/zm_096.bin",
        "size": 522240,
        "sha256": "e6b76d86ca459d8ce87d2a41c812319b11e9563ecf1ba80a4e86a368d6c02fbc"
      },
      {
        "path": "voices/zm_097.bin",
        "size": 522240,
        "sha256": "e60ec05738261c2eb13c43f7429ece6b32e0992223b0a6336a9fcdec90fb8da4"
      },
      {
        "path": "voices/zm_098.bin",
        "size": 522240,
        "sha256": "7dd142334e863af31c7e0d0fbe491b8d54083ff5322441d550fcfc5e4111480d"
      },
      {
        "path": "voices/zm_100.bin",
        "size": 522240,
        "sha256": "112de52f1aab3b370fd01f4e2e1d8bb37fee2725e77e14b81c802d50687e0e6e"
      }
    ]
  },
  "coreml": {
    "repo": "FluidInference/kokoro-82m-coreml",
    "revision": "51c072023b254cd02368102ab88bcfbff6cad4cd",
    "stages": [
      "KokoroAlbert",
      "KokoroPostAlbert",
      "KokoroAlignment",
      "KokoroProsody_v2",
      "KokoroNoise_v2",
      "KokoroVocoder_v2",
      "KokoroTail_v2"
    ],
    "files": [
      {
        "path": "ANE-zh/KokoroAlbert.mlmodelc/analytics/coremldata.bin",
        "size": 243,
        "sha256": "e3b66851b7a61e9b2f2fb17a5050a46f5d98acaec46b3822b65c3e509c15c94e"
      },
      {
        "path": "ANE-zh/KokoroAlbert.mlmodelc/coremldata.bin",
        "size": 433,
        "sha256": "bae8190320b079bc995d69b19c2247c2e66faf5ebefe0cfb99bddf4efa98a86c"
      },
      {
        "path": "ANE-zh/KokoroAlbert.mlmodelc/metadata.json",
        "size": 2480,
        "sha256": "d5fbc004f1b6eb8e15efe4392e702b7d064e704536e1b585e7cd910a62680fd2"
      },
      {
        "path": "ANE-zh/KokoroAlbert.mlmodelc/model.mil",
        "size": 101485,
        "sha256": "3af07f753779fdd7d81cf482098a2a94feda50f677b8ce606c14596c2f44e732"
      },
      {
        "path": "ANE-zh/KokoroAlbert.mlmodelc/weights/weight.bin",
        "size": 5718848,
        "sha256": "8c3d8458f357f2e60380de284139af566c6c22e3719bb985524616d0a4f57e5b"
      },
      {
        "path": "ANE-zh/KokoroAlignment.mlmodelc/analytics/coremldata.bin",
        "size": 243,
        "sha256": "7c84c8820e2e6f1b27229db6ce4ec2cc2817c546aa31d2d2f677d35be5445443"
      },
      {
        "path": "ANE-zh/KokoroAlignment.mlmodelc/coremldata.bin",
        "size": 484,
        "sha256": "8bede89325746a1b540c3350a473ceeaea39a5cea7a641c340e9013655865936"
      },
      {
        "path": "ANE-zh/KokoroAlignment.mlmodelc/metadata.json",
        "size": 3021,
        "sha256": "a1e61d00267f01da2ea32fea44a2c1c04e1a04533b1464bdbc48de03f69e3099"
      },
      {
        "path": "ANE-zh/KokoroAlignment.mlmodelc/model.mil",
        "size": 8194,
        "sha256": "107daf70364aab37665fd29509c3be81a1b046c04a368d780ec43b0afe5b5064"
      },
      {
        "path": "ANE-zh/KokoroAlignment.mlmodelc/weights/weight.bin",
        "size": 4128,
        "sha256": "2e7d69128b59d615fc3d3cf85637a687235fc086b1eb136359adb11a61615f6b"
      },
      {
        "path": "ANE-zh/KokoroNoise_v2.mlmodelc/analytics/coremldata.bin",
        "size": 243,
        "sha256": "7eacfc0eb5b0f576ccc38e6ac8c1746e740dab1459cb9a3408542576723cc012"
      },
      {
        "path": "ANE-zh/KokoroNoise_v2.mlmodelc/coremldata.bin",
        "size": 440,
        "sha256": "3d8f933a62fc1d0b08f97bd776afa61d887bca7c3f93a21b5ff3d92cb88099ee"
      },
      {
        "path": "ANE-zh/KokoroNoise_v2.mlmodelc/metadata.json",
        "size": 3091,
        "sha256": "44e7cab52849d84da4b603e17b2b6ab61ee31f5ea5645b4765b5160942b63afa"
      },
      {
        "path": "ANE-zh/KokoroNoise_v2.mlmodelc/model.mil",
        "size": 93152,
        "sha256": "58b78ba89d89e1e3aacecabd2ad5f504f6eae5ae1796b11b819598452afb1dc3"
      },
      {
        "path": "ANE-zh/KokoroNoise_v2.mlmodelc/weights/weight.bin",
        "size": 4580160,
        "sha256": "2bf3f47ba8851668634ae7e28e0df8854c0f56add4177ca38054036a846de24a"
      },
      {
        "path": "ANE-zh/KokoroPostAlbert.mlmodelc/analytics/coremldata.bin",
        "size": 243,
        "sha256": "9ac50dad158a0dc349a240675d84ad920ae3202f282fc70fb2b833d78eb6829f"
      },
      {
        "path": "ANE-zh/KokoroPostAlbert.mlmodelc/coremldata.bin",
        "size": 556,
        "sha256": "c9246412170c6118149ccf412efafbb76db5bd47946776a1897b046ca2576f95"
      },
      {
        "path": "ANE-zh/KokoroPostAlbert.mlmodelc/metadata.json",
        "size": 4171,
        "sha256": "fdc356568fef6d2a7a88a31d1934498c9466da48e95822e7176d9ec055b8be5c"
      },
      {
        "path": "ANE-zh/KokoroPostAlbert.mlmodelc/model.mil",
        "size": 60047,
        "sha256": "325c79e75c3f883b575dbef00efd22a9cee523bdd6a556efe5506c505c2a624d"
      },
      {
        "path": "ANE-zh/KokoroPostAlbert.mlmodelc/weights/weight.bin",
        "size": 13806464,
        "sha256": "bca73c9f402ccd18052fe8cc418741caa196c3caceeb3637187cdc5d67d8daf7"
      },
      {
        "path": "ANE-zh/KokoroProsody_v2.mlmodelc/analytics/coremldata.bin",
        "size": 243,
        "sha256": "623c7ad069ba684c8d58d545de23e72456d66deeb5ce84c59ae2f70ccbaa37a2"
      },
      {
        "path": "ANE-zh/KokoroProsody_v2.mlmodelc/coremldata.bin",
        "size": 422,
        "sha256": "ae6eb6035b2e24124753a6fe42a66972723da55630d966def4dc3fc655f3e1ff"
      },
      {
        "path": "ANE-zh/KokoroProsody_v2.mlmodelc/model.mil",
        "size": 73353,
        "sha256": "b44105f7428f17dcb8f0b1544f08b3ce038927610180ad726c3ff5aec693fa7e"
      },
      {
        "path": "ANE-zh/KokoroProsody_v2.mlmodelc/weights/weight.bin",
        "size": 8513664,
        "sha256": "9835a7d16162985bbac5cde1ad206b1092e935ffc958146a4d137ab83eeae82f"
      },
      {
        "path": "ANE-zh/KokoroTail_v2.mlmodelc/analytics/coremldata.bin",
        "size": 243,
        "sha256": "cbffea509dfcba72fae7a9dc7ae424e19f8af08eabc70360fe30fd7c1de09151"
      },
      {
        "path": "ANE-zh/KokoroTail_v2.mlmodelc/coremldata.bin",
        "size": 392,
        "sha256": "94e611a84f91c7b135b031a0f978cc47b0edab42912e68a86c3f3e78f9edf6a0"
      },
      {
        "path": "ANE-zh/KokoroTail_v2.mlmodelc/metadata.json",
        "size": 1872,
        "sha256": "d3c8a18ae48455281d614c098658c606174c2f02f594022232d427ac7070c899"
      },
      {
        "path": "ANE-zh/KokoroTail_v2.mlmodelc/model.mil",
        "size": 7014,
        "sha256": "05abf10a8c6fdc77a614948a1d2a8b2374ac71daf2b24aaee077044067fde15f"
      },
      {
        "path": "ANE-zh/KokoroTail_v2.mlmodelc/weights/weight.bin",
        "size": 81088,
        "sha256": "242d455874b12c81bd09919d22cbd3d863242dc7a19b726dfff08142d59f2971"
      },
      {
        "path": "ANE-zh/KokoroVocoder_v2.mlmodelc/analytics/coremldata.bin",
        "size": 243,
        "sha256": "6e71e554b33c99af3c5751b0f37275e5fe824bf255c14c984db4b65882f34d60"
      },
      {
        "path": "ANE-zh/KokoroVocoder_v2.mlmodelc/coremldata.bin",
        "size": 628,
        "sha256": "b37798b3b5336325c7d4170fcd1b03a652513124a394cd0ed05105f5ba56b2ff"
      },
      {
        "path": "ANE-zh/KokoroVocoder_v2.mlmodelc/metadata.json",
        "size": 4416,
        "sha256": "2e7a96ceb2ed6c639117972069a6cca3bc09580de6dfad23e001cc03f2a63913"
      },
      {
        "path": "ANE-zh/KokoroVocoder_v2.mlmodelc/model.mil",
        "size": 277523,
        "sha256": "693d8ef9b8032c91ed0108b8208dd1bed117f6e7d14712b0c5f6e5158006fa05"
      },
      {
        "path": "ANE-zh/KokoroVocoder_v2.mlmodelc/weights/weight.bin",
        "size": 49084224,
        "sha256": "cfbf00f898a9bcb71863f5b4ad264b2483ec3757b401722c2d20e2e7e946e983"
      }
    ]
  }
} as const;

export const KOKORO_VOICE_IDS: readonly string[] = KOKORO_MANIFEST.onnx.voices.map((v) =>
  v.path.replace(/^voices\//, '').replace(/\.bin$/, ''),
);

export function getKokoroVoiceFile(voiceId: string): KokoroManifestFile | null {
  const target = `voices/${voiceId}.bin`;
  return KOKORO_MANIFEST.onnx.voices.find((v) => v.path === target) ?? null;
}

export function kokoroVoiceLang(voiceId: string): 'zh-CN' | 'en-US' | 'en-GB' {
  if (voiceId.startsWith('z')) return 'zh-CN';
  if (voiceId.startsWith('b')) return 'en-GB';
  return 'en-US';
}

export function formatKokoroVoiceName(voiceId: string, uiLocale = 'en'): string {
  const isZhUi = uiLocale.toLowerCase().startsWith('zh');
  if (voiceId === 'af_maple') return 'Kokoro Maple (US)';
  if (voiceId === 'af_sol') return 'Kokoro Sol (US)';
  if (voiceId === 'bf_vale') return 'Kokoro Vale (UK)';
  const m = voiceId.match(/^(zf|zm)_(\d+)$/);
  if (m) {
    const gender = m[1] === 'zf' ? (isZhUi ? '女声' : 'Female') : (isZhUi ? '男声' : 'Male');
    return `Kokoro ${gender} ${m[2]}`;
  }
  return `Kokoro ${voiceId}`;
}

export function listKokoroCatalogVoices(uiLocale = 'en'): Voice[] {
  return KOKORO_VOICE_IDS.map((id) => ({
    id,
    provider: 'kokoro',
    name: formatKokoroVoiceName(id, uiLocale),
    lang: kokoroVoiceLang(id),
    quality: 'neural',
    local: true,
  }));
}

/**
 * Clamps the voice style pack row (`(510, 1, 256)` float32 LE) per Python reference:
 * `row = clamp(tokenCount - 1, 0, 509)` (`TTS_V2_SPEC.md` §1 E4, §5).
 */
export function kokoroStyleRowIndex(unpaddedTokenCount: number): number {
  return Math.max(0, Math.min(KOKORO_VOICE_ROWS - 1, Math.trunc(unpaddedTokenCount) - 1));
}

/** Byte offset into a `522,240`-byte `.bin` voice file for `unpaddedTokenCount` (`row * 1024`). */
export function kokoroVoiceSliceByteOffset(unpaddedTokenCount: number): number {
  return kokoroStyleRowIndex(unpaddedTokenCount) * KOKORO_VOICE_DIM * 4;
}

/**
 * Extracts the 256-float style vector (`float32[1, 256]`) for `unpaddedTokenCount` from a
 * `522,240`-byte `(510, 1, 256)` little-endian `.bin` voice pack (`TTS_V2_SPEC.md` §1 E4, §5).
 */
export function extractKokoroVoiceStyleRow(
  voiceBinBytes: Uint8Array,
  unpaddedTokenCount: number,
): Float32Array {
  if (voiceBinBytes.byteLength !== KOKORO_VOICE_BIN_BYTES) {
    throw new Error(
      `Invalid Kokoro voice pack byte length: expected ${KOKORO_VOICE_BIN_BYTES}, got ${voiceBinBytes.byteLength}`,
    );
  }
  const byteOffset = kokoroVoiceSliceByteOffset(unpaddedTokenCount);
  const out = new Float32Array(KOKORO_VOICE_DIM);
  const view = new DataView(
    voiceBinBytes.buffer,
    voiceBinBytes.byteOffset + byteOffset,
    KOKORO_VOICE_DIM * 4,
  );
  for (let i = 0; i < KOKORO_VOICE_DIM; i++) {
    out[i] = view.getFloat32(i * 4, true);
  }
  return out;
}

/**
 * Splits a 256-float Kokoro voice row into Core ML `timbre` (`[0..128)`) and `style` (`[128..256)`)
 * (`TTS_V2_SPEC.md` §1 E4, §5.3).
 */
export function splitKokoroCoreMLVoiceRow(styleRow256: Float32Array): {
  readonly timbre: Float32Array;
  readonly style: Float32Array;
} {
  if (styleRow256.length !== KOKORO_VOICE_DIM) {
    throw new Error(`Expected ${KOKORO_VOICE_DIM}-element style row, got ${styleRow256.length}`);
  }
  return {
    timbre: styleRow256.slice(0, 128),
    style: styleRow256.slice(128, 256),
  };
}

/**
 * Validates synthesized audio samples against NaN/Inf and silence (`TTS_V2_SPEC.md` §5):
 * Self-test uses `minPeak: 0.01` and `duration` in `[500, 4000] ms`; runtime uses `minPeak: 1e-3`.
 */
export function validateKokoroWaveform(
  samples: Float32Array | readonly number[],
  opts?: {
    readonly sampleRate?: number;
    readonly minPeak?: number;
    readonly minDurationMs?: number;
    readonly maxDurationMs?: number;
  },
): { readonly valid: boolean; readonly finite: boolean; readonly peak: number; readonly durationMs: number } {
  const sampleRate = opts?.sampleRate ?? KOKORO_SAMPLE_RATE;
  const minPeak = opts?.minPeak ?? 1e-3;
  const durationMs = samples.length > 0 ? (samples.length / sampleRate) * 1000 : 0;
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]!;
    if (!Number.isFinite(v)) {
      return { valid: false, finite: false, peak, durationMs };
    }
    const abs = Math.abs(v);
    if (abs > peak) peak = abs;
  }
  const durationOk =
    (opts?.minDurationMs === undefined || durationMs >= opts.minDurationMs) &&
    (opts?.maxDurationMs === undefined || durationMs <= opts.maxDurationMs);
  const valid = samples.length > 0 && peak >= minPeak && durationOk;
  return { valid, finite: true, peak, durationMs };
}

/** Resolves ordered mirror base URLs (`TTS_V2_SPEC.md` §3.2). */
export function resolveModelSources(
  settings: {
    readonly modelDownloadSource?: ModelDownloadSource;
    readonly modelMirrorBaseUrl?: string | null;
  },
  env?: { readonly timeZone?: string; readonly locale?: string },
): string[] {
  const source = settings.modelDownloadSource ?? 'auto';
  const normalizeBase = (u: string): string => u.trim().replace(/\/+$/, '');

  if (source === 'huggingface') {
    return [HF_OFFICIAL_BASE];
  }
  if (source === 'hf-mirror') {
    return [HF_MIRROR_BASE];
  }
  if (source === 'custom') {
    const custom = settings.modelMirrorBaseUrl ? normalizeBase(settings.modelMirrorBaseUrl) : '';
    if (custom && /^https:\/\//i.test(custom)) {
      return [custom, HF_MIRROR_BASE, HF_OFFICIAL_BASE];
    }
    return [HF_MIRROR_BASE, HF_OFFICIAL_BASE];
  }

  let tz = env?.timeZone;
  if (!tz) {
    try {
      tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch {
      tz = undefined;
    }
  }
  const locale = (env?.locale ?? '').toLowerCase();
  const preferMirror = (tz !== undefined && CN_TIMEZONES.has(tz)) || locale === 'zh-cn' || locale.startsWith('zh-hans-cn');
  return preferMirror ? [HF_MIRROR_BASE, HF_OFFICIAL_BASE] : [HF_OFFICIAL_BASE, HF_MIRROR_BASE];
}

export function resolveAllowedModelHosts(customMirrorBaseUrl?: string | null): string[] {
  const out = [...DEFAULT_ALLOWED_MODEL_HOSTS];
  if (customMirrorBaseUrl) {
    try {
      const u = new URL(customMirrorBaseUrl.trim());
      if (u.protocol === 'https:' && u.hostname && !out.includes(u.hostname.toLowerCase())) {
        out.push(u.hostname.toLowerCase());
      }
    } catch {
      // ignore invalid custom URL
    }
  }
  return out;
}

export function isAllowedModelRedirectUrl(
  targetUrl: string,
  allowHosts: readonly string[] = DEFAULT_ALLOWED_MODEL_HOSTS,
): boolean {
  let parsed: URL;
  try {
    parsed = new URL(targetUrl);
  } catch {
    return false;
  }
  if (parsed.protocol !== 'https:') return false;
  const host = parsed.hostname.toLowerCase();
  if (!host) return false;
  for (const rule of allowHosts) {
    const r = rule.toLowerCase();
    if (r.startsWith('*.')) {
      const suffix = r.slice(1); // '.hf.co'
      if (host.endsWith(suffix) && host.length > suffix.length) return true;
    } else if (r.startsWith('.')) {
      if (host.endsWith(r) && host.length > r.length) return true;
    } else if (host === r) {
      return true;
    }
  }
  return false;
}

export function buildModelResolveUrl(
  baseUrl: string,
  repo: string,
  revision: string,
  filePath: string,
): string {
  const base = baseUrl.trim().replace(/\/+$/, '');
  const cleanPath = filePath.replace(/^\/+/, '');
  return `${base}/${repo}/resolve/${revision}/${cleanPath}`;
}

export function isSafeManifestRelativePath(relPath: string): boolean {
  if (!relPath || relPath.length > 240) return false;
  if (!/^[A-Za-z0-9._/-]+$/.test(relPath)) return false;
  const parts = relPath.split('/');
  return parts.every((p) => p.length > 0 && p !== '.' && p !== '..');
}

/**
 * Returns the ordered list of model + voice files required for `variant` and `voices`
 * (defaults to `KOKORO_DEFAULT_VOICES` when `voices` is omitted).
 */
export function resolveManifestFilesForVariant(
  variant: SpeechModelVariant,
  voices: readonly string[] = KOKORO_DEFAULT_VOICES,
): ResolvedKokoroDownloadFile[] {
  const out: ResolvedKokoroDownloadFile[] = [];
  if (variant === 'onnx-fp32') {
    out.push({
      ...KOKORO_MANIFEST.onnx.models.fp32,
      repo: KOKORO_MANIFEST.onnx.repo,
      revision: KOKORO_MANIFEST.onnx.revision,
    });
  } else if (variant === 'onnx-q8') {
    out.push({
      ...KOKORO_MANIFEST.onnx.models.q8,
      repo: KOKORO_MANIFEST.onnx.repo,
      revision: KOKORO_MANIFEST.onnx.revision,
    });
  } else {
    for (const f of KOKORO_MANIFEST.coreml.files) {
      out.push({
        ...f,
        repo: KOKORO_MANIFEST.coreml.repo,
        revision: KOKORO_MANIFEST.coreml.revision,
      });
    }
  }

  const seenVoices = new Set<string>();
  for (const voiceId of voices) {
    if (seenVoices.has(voiceId)) continue;
    seenVoices.add(voiceId);
    const vf = getKokoroVoiceFile(voiceId);
    if (vf) {
      out.push({
        ...vf,
        repo: KOKORO_MANIFEST.onnx.repo,
        revision: KOKORO_MANIFEST.onnx.revision,
      });
    }
  }
  return out;
}

export function totalManifestBytesForVariant(
  variant: SpeechModelVariant,
  voices: readonly string[] = KOKORO_DEFAULT_VOICES,
): number {
  return resolveManifestFilesForVariant(variant, voices).reduce((sum, f) => sum + f.size, 0);
}
