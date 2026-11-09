const imagePatterns=[['GPT Image',/\bGPT(?:\s*Image|[-\s]\d|\b)/i],['Nano Banana',/nano[\s_-]*banana/i],['Midjourney',/midjourney|\bMJ\b/i],['FLUX',/\bFLUX\b/i],['Seedream',/seedream/i]];
const videoPatterns=[['Seedance',/seedance/i],['Kling',/\bKling\b|可灵/i],['Wan',/\bWan(?:\s*\d|\b)|万相/i],['Hailuo',/hailuo|海螺/i],['Veo',/\bVeo\b/i],['Sora',/\bSora\b/i]];
export function inferModel(content,type='image',fallback){
  const text=String(content||'');
  const primary=type==='video'?videoPatterns:imagePatterns;
  for(const [model,pattern] of primary)if(pattern.test(text))return model;
  if(/\bGrok\b/i.test(text))return 'Grok';
  if(/豆包|doubao/i.test(text))return type==='video'?'Seedance':'Seedream';
  if(type!=='video')for(const [model,pattern] of videoPatterns)if(pattern.test(text))return model;
  return type==='video'?'Seedance':(fallback||'GPT Image');
}
