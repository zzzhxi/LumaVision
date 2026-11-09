import test from 'node:test';
import assert from 'node:assert/strict';
import {inferModel} from '../scripts/model-inference.mjs';
test('recognizes current model families and type-specific defaults',()=>{
  for(const model of ['GPT Image','Nano Banana','Midjourney','FLUX','Seedream'])assert.equal(inferModel(model,'image'),model);
  for(const model of ['Seedance','Kling','Wan','Hailuo'])assert.equal(inferModel(model,'video'),model);
  assert.equal(inferModel('','image'),'GPT Image');assert.equal(inferModel('','video','GPT Image'),'Seedance');
  assert.equal(inferModel('豆包','image'),'Seedream');assert.equal(inferModel('豆包','video'),'Seedance');
  assert.equal(inferModel('GPT Image storyboard, Kling final video','video'),'Kling');
  assert.equal(inferModel('GPT Image storyboard','video'),'Seedance');
  assert.equal(inferModel('豆包 Seedance','video'),'Seedance');
});
