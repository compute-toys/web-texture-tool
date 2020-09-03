// Copyright 2020 Brandon Jones
//
// Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated
// documentation files (the "Software"), to deal in the Software without restriction, including without limitation the
// rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to
// permit persons to whom the Software is furnished to do so, subject to the following conditions:

// The above copyright notice and this permission notice shall be included in all copies or substantial portions of the
// Software.

// THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE
// WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR
// COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR
// OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

/**
 * @file Web Worker for loading/transcoding KTX files
 * @module KTXLoader
 *
 * Loads the Khronos Standard KTX2 file format (spec: http://github.khronos.org/KTX-Specification/)
 * Basis transcoding is handled by Web Assembly code in msc_transcoder_wrapper.wasm, which is maintained at
 * https://github.com/KhronosGroup/KTX-Software
 */

importScripts('../worker-util.js');
importScripts('libktx.js');

// eslint-disable-next-line new-cap
const KTX_INITIALIZED = new Promise((resolve) => {
  // Turns out this isn't a "real" promise, so we can't use it with await later on. Hence the wrapper promise.
  LIBKTX().then(resolve);
});

const WTT_FORMAT_MAP = {
  // Compressed formats
  BC1_RGB: {format: 'bc1-rgb-unorm'},
  BC3_RGBA: {format: 'bc3-rgba-unorm'},
  BC7_M5_RGBA: {format: 'bc7-rgba-unorm'},
  ETC1_RGB: {format: 'etc1-rgb-unorm'},
  ETC2_RGBA: {format: 'etc2-rgba8unorm'},
  ASTC_4x4_RGBA: {format: 'astc-4x4-rgba-unorm'},
  PVRTC1_4_RGB: {format: 'pvrtc1-4bpp-rgb-unorm'},
  PVRTC1_4_RGBA: {format: 'pvrtc1-4bpp-rgba-unorm'},

  // Uncompressed formats
  RGBA32: {format: 'rgba8unorm', uncompressed: true},
  RGB565: {format: 'rgb565unorm', uncompressed: true},
  RGBA4444: {format: 'rgba4unorm', uncompressed: true},
};

// See http://richg42.blogspot.com/2018/05/basis-universal-gpu-texture-format.html for details.
// ETC1 Should be the highest quality, so use when available.
// If we don't support any appropriate compressed formats transcode to raw RGB(A) pixels. This is something of a last
// resort, because the GPU upload will be significantly slower and take a lot more memory, but at least it prevents you
// from needing to store a fallback JPG/PNG and the download size will still likely be smaller.
const alphaFormatPreference = [
  'ETC2_RGBA', 'BC7_M5_RGBA', 'BC3_RGBA', 'ASTC_4x4_RGBA', 'PVRTC1_4_RGBA', 'RGBA32'];
const opaqueFormatPreference = [
  'ETC1_RGB', 'BC7_M5_RGBA', 'BC1_RGB', 'ETC2_RGBA', 'ASTC_4x4_RGBA', 'PVRTC1_4_RGB', 'RGB565', 'RGBA32'];

async function parseFile(buffer, supportedFormats, mipmaps) {
  const ktx = await KTX_INITIALIZED;

  const ktxTexture = new ktx.ktxTexture(new Uint8Array(buffer));

  let format;
  if (ktxTexture.needsTranscoding) {
    let transcodeFormat;
    // eslint-disable-next-line guard-for-in
    for (const targetFormat of alphaFormatPreference) {
      const wttFormat = WTT_FORMAT_MAP[targetFormat];
      if (supportedFormats.indexOf(wttFormat.format) > -1) {
        format = wttFormat.format;
        transcodeFormat = ktx.TranscodeTarget[targetFormat];
        break;
      }
    }

    if (!transcodeFormat) {
      throw new Error('No appropriate transcode format found.');
    }

    const result = ktxTexture.transcodeBasis(transcodeFormat, 0);
    if (result != ktx.ErrorCode.SUCCESS) {
      throw new Error('Unable to transcode basis texture.');
    }
  } else {
    // TODO: figure out how to map to the Vulkan formats here.
    // ktxTexture.vkFormat;
    throw new Error('Uncompressed formats not yet supported.');
  }

  const textureData = new WorkerTextureData(format, ktxTexture.baseWidth, ktxTexture.baseHeight);

  // Transcode each mip level of each image.
  for (let level = 0; level < ktxTexture.numLevels; ++level) {
    for (let layer = 0; layer < ktxTexture.numLayers; ++layer) {
      for (let face = 0; face < ktxTexture.numFaces; ++face) {
        const imageNumber = (layer * ktxTexture.numFaces) + face;
        const textureImage = textureData.getImage(imageNumber);

        const imageData = ktxTexture.getImageData(level, layer, face);

        // Copy to a new Uint8Array for transfer.
        const levelData = new Uint8Array(imageData.byteLength);
        levelData.set(imageData);
        textureImage.setMipLevel(level, levelData);
      }
    }
  }

  return textureData;
}

onmessage = CreateTextureMessageHandler(parseFile);
