import puppeteer from 'puppeteer-core';
import { launchOpts } from './chrome.mjs';

const browser = await puppeteer.launch(launchOpts(['--enable-unsafe-webgpu']));
const page = await browser.newPage();
await page.setContent('<canvas id=c></canvas>');
const info = await page.evaluate(() => {
  const gl = document.getElementById('c').getContext('webgl2');
  if (!gl) return 'no webgl2';
  const d = gl.getExtension('WEBGL_debug_renderer_info');
  return {
    renderer: d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
    clip: !!gl.getExtension('EXT_clip_control'),
    cbf: !!gl.getExtension('EXT_color_buffer_float'),
    fl: !!gl.getExtension('OES_texture_float_linear'),
    maxTex: gl.getParameter(gl.MAX_TEXTURE_SIZE),
  };
});
console.log(JSON.stringify(info));
await browser.close();
