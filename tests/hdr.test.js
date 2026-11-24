const assert=require('node:assert/strict');
const {test}=require('node:test');
const fs=require('node:fs'),vm=require('node:vm');
const CmafDash=require('../app/js/cmaf.js');
const plain=x=>JSON.parse(JSON.stringify(x));
const kid='00112233-4455-6677-8899-aabbccddeeff', hdrKid='10213243-5465-7687-98a9-bacbdcedfe0f';
const box=(n,p)=>{const b=Buffer.alloc(8);b.writeUInt32BE(p.length+8);b.write(n,4);return Buffer.concat([b,p]);};
const u32=n=>{const b=Buffer.alloc(4);b.writeUInt32BE(n);return b;};
const tenc=box('tenc',Buffer.concat([Buffer.from([1,0,0,0,0,0x19,1,0]),Buffer.from(hdrKid.replaceAll('-',''),'hex'),Buffer.from([16]),Buffer.alloc(16)]));
const sinf=box('sinf',Buffer.concat([box('schm',Buffer.concat([Buffer.alloc(4),Buffer.from('cbcs'),u32(65536)])),box('schi',tenc)]));
const stsd=box('stsd',Buffer.concat([Buffer.alloc(4),u32(1),box('encv',Buffer.concat([Buffer.alloc(78),sinf]))]));
const mdhd=box('mdhd',Buffer.concat([Buffer.alloc(12),u32(50000),Buffer.alloc(8)]));
const init=box('moov',box('trak',box('mdia',Buffer.concat([mdhd,box('minf',box('stbl',stsd))]))));
const stamp=Buffer.alloc(8);stamp.writeBigUInt64BE(89669822112000n);
const frag=box('moof',box('traf',box('tfdt',Buffer.concat([Buffer.from([1,0,0,0]),stamp]))));
const pssh=Buffer.concat([Buffer.from('public-widevine-metadata'),Buffer.from(kid.replaceAll('-',''),'hex')]).toString('base64');
const cp=`<ContentProtection schemeIdUri="urn:mpeg:dash:mp4protection:2011" value="cbcs" cenc:default_KID="${kid}"/><ContentProtection schemeIdUri="urn:uuid:edef8ba9-79d6-4ace-a3c8-27dcd51d21ed"><cenc:pssh>${pssh}</cenc:pssh></ContentProtection>`;
const templ='<SegmentTemplate timescale="50000" presentationTimeOffset="89669822112000" initialization="init.mp4" media="a_$Number$.m4s"><SegmentTimeline><S t="89669822112000" d="288000" r="1"/></SegmentTimeline></SegmentTemplate>';
const mpd=`<MPD type="static"><Period start="PT0S"><AdaptationSet contentType="video">${cp}<Representation codecs="avc1.4d4029">${templ}</Representation></AdaptationSet><AdaptationSet contentType="audio" lang="eng">${cp}${templ}</AdaptationSet><AdaptationSet contentType="audio" lang="deu">${cp}${templ}</AdaptationSet><AdaptationSet contentType="application" codecs="stpp" lang="eng">${templ}<Representation id="_SUBS_1" bandwidth="256"/></AdaptationSet></Period></MPD>`;
const master=`#EXTM3U
#EXT-X-SESSION-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://${hdrKid}"
#EXT-X-STREAM-INF:BANDWIDTH=18000000,RESOLUTION=3840x2160,CODECS="hev1.2.4.L153.B0,mp4a.40.2",VIDEO-RANGE=HLG,AUDIO="aac"
v/uhd.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="hev1.2.4.L123.B0,mp4a.40.2",VIDEO-RANGE=HLG,AUDIO="aac"
v/hd.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=4000000,RESOLUTION=1920x1080,CODECS="hev1.1.6.L123.B0",VIDEO-RANGE=SDR
sdr.m3u8
`;
const playlist=`#EXTM3U\n#EXT-X-MAP:URI="init.mp4?sig=one&n=2"\n#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://${hdrKid}"\n#EXTINF:5.76,\nv_100.m4s?sig=keep&n=2\n#EXTINF:5.76,\nv_101.m4s?sig=keep&n=2\n#EXT-X-ENDLIST\n`;
function harness(overrides={}, redirects={}, langs={audio:'deu',text:'eng'}, late={}){
 const calls=[];let offset=0;
 const ctx=vm.createContext({CmafDash,URL,Uint8Array,AbortController,setTimeout,clearTimeout,Date:{now:()=>Date.now()+offset},btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary'),fetch:async (url,opts={})=>{calls.push({url,opts});offset+=late[url]||0;let body=url.endsWith('master.m3u8')?master:url.endsWith('.mpd')?mpd:url.includes('.m3u8')?playlist:url.includes('init.mp4')?init:frag;body=overrides[url]??body;return {ok:true,url:redirects[url]||url,text:async()=>body,arrayBuffer:async()=>Uint8Array.from(body).buffer};}});
 vm.runInContext(fs.readFileSync('app/js/hdr.js','utf8'),ctx);
 const built=()=>ctx.HdrStream.build({url:'https://video.formula1.com/vod/master.m3u8',widevineManifestUrl:'https://video.formula1.com/sdr/index.mpd'},langs);
 return {calls,built,build:()=>built().then(r=>r.mpd),ctx};
}
test('encrypted HDR keeps only HLG qualities and preserves every official commentary',async()=>{
 const h=harness(),xml=await h.build();
 assert.equal((xml.match(/<Representation /g)||[]).length,2); // both video representations; official audio/text bodies are retained separately
 assert.equal((xml.match(/<AdaptationSet contentType="video"/g)||[]).length,1);
 assert.ok(xml.includes('width="3840" height="2160"'));
 assert.ok(xml.includes('lang="eng"'));assert.ok(xml.includes('lang="deu"'));
 assert.ok(!xml.includes('contentType="application"')); // subtitles are shown by the app (ttml.js), not AVPlay
 assert.ok(!xml.includes('avc1.4d4029'));
 assert.ok(xml.includes('v_$Number$.m4s?sig=keep&amp;n=2'));
 assert.ok(xml.includes('http://127.0.0.1:18765/s/'));
 assert.ok(xml.includes('/s/'+Buffer.from('https://video.formula1.com/sdr/').toString('base64url')+'/'));
 assert.ok(xml.indexOf('lang="deu"')<xml.indexOf('contentType="audio" lang="eng"'));
 assert.ok(h.calls.filter(c=>c.url.includes('v_100')).every(c=>c.opts.headers.Range==='bytes=0-65535'));
});
// A discontinuity whose media timestamps jump (the harness serves every segment with the first one's tfdt).
const broken=playlist.replace('#EXTINF:5.76,\nv_101','#EXT-X-DISCONTINUITY\n#EXTINF:5.76,\nv_101');
for(const [name,url,body] of [
 ['a discontinuity where the timestamps jump','https://video.formula1.com/vod/v/uhd.m3u8',broken],
 ['key mismatch','https://video.formula1.com/vod/v/uhd.m3u8',playlist.replace(hdrKid,kid)],
 ['unmatched clock','https://video.formula1.com/sdr/index.mpd',mpd.replaceAll('presentationTimeOffset="89669822112000"','presentationTimeOffset="89669812112000"')],
 ['dynamic source','https://video.formula1.com/sdr/index.mpd',mpd.replace('type="static"','type="dynamic"')],
 ['no HLG','https://video.formula1.com/vod/master.m3u8',master.replaceAll('VIDEO-RANGE=HLG','VIDEO-RANGE=SDR')]
])test('encrypted HDR rejects '+name+' for safe SDR recovery',async()=>{await assert.rejects(harness({[url]:body}).build());});


// F1 LIVE and the shows: a second audio group with AC-3 5.1 (English, Spanish) beside the stereo AAC, on the video's key.
const master51=master.replace('#EXT-X-STREAM-INF:BANDWIDTH=18000000,','#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ac3",CHANNELS="6",NAME="eng",LANGUAGE="eng",URI="a/eng51.m3u8"\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="ac3",CHANNELS="6",NAME="spa",LANGUAGE="spa",URI="a/spa51.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=18384000,RESOLUTION=3840x2160,CODECS="hev1.2.4.L153.B0,ac-3",VIDEO-RANGE=HLG,AUDIO="ac3"\nv/uhd.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=18000000,');
const surroundSets=xml=>(xml.match(/<AdaptationSet[^>]*>(?:(?!<\/AdaptationSet>)[\s\S])*codecs="ac-3"[\s\S]*?<\/AdaptationSet>/g)||[]);
test('encrypted HDR adds the HLS 5.1 commentary on the video key and clock, through the helper, after the chosen stereo language',async()=>{
 const xml=await harness({'https://video.formula1.com/vod/master.m3u8':master51}).build();
 const sets=surroundSets(xml);
 assert.equal(sets.length,2);
 assert.ok(sets[0].includes('lang="eng"')&&sets[1].includes('lang="spa"'));
 assert.ok(sets.every(x=>x.includes('cenc:default_KID="'+hdrKid+'"')&&x.includes('urn:uuid:edef8ba9')));
 assert.ok(sets[0].includes('/s/'+Buffer.from('https://video.formula1.com/vod/a/').toString('base64url')+'/v_$Number$.m4s?sig=keep&amp;n=2'));
 assert.ok(sets[0].includes('presentationTimeOffset="89669822112000"'));
 // The viewer chose German, which only the stereo commentary has: AVPlay starts on it.
 assert.ok(xml.indexOf('<AdaptationSet contentType="audio" lang="deu"')<xml.indexOf('codecs="ac-3"'));
});
test('encrypted HDR starts on the 5.1 commentary in the chosen language',async()=>{
 const xml=await harness({'https://video.formula1.com/vod/master.m3u8':master51},{},{audio:'spa',text:''}).build();
 const first=xml.indexOf('<AdaptationSet contentType="audio"');
 assert.ok(xml.slice(first,xml.indexOf('</AdaptationSet>',first)).includes('codecs="ac-3"'));
 assert.ok(xml.slice(first,xml.indexOf('</AdaptationSet>',first)).includes('lang="spa"'));
 assert.ok(xml.indexOf('codecs="ac-3"')<xml.indexOf('<AdaptationSet contentType="audio" lang="eng"'));
});
test('encrypted HDR multiview adds the 5.1 commentary of the feed whose sound plays',async()=>{
 const h=harness({'https://video.formula1.com/vod/master.m3u8':master51,'http://127.0.0.1:18765/stitch/g1':JSON.stringify({width:3840,height:3264,codecs:'hev1.2.4.L153.B0'})});
 h.ctx.MultiviewLayouts={layouts:{duo:{feeds:[2160,1080]}}};h.ctx.navigator={userAgent:'test'};
 const lead={url:'https://video.formula1.com/vod/master.m3u8',widevineManifestUrl:'https://video.formula1.com/sdr/index.mpd',hdr:true,hdrEncrypted:true};
 const {mpd}=await h.ctx.HdrStream.grid([lead,{url:'https://video.formula1.com/vod/master.m3u8',hdr:true}],'duo',{id:'g1',langs:{audio:'eng',text:''},audio:0});
 const first=mpd.indexOf('<AdaptationSet contentType="audio"');
 assert.ok(mpd.slice(first,mpd.indexOf('</AdaptationSet>',first)).includes('codecs="ac-3"'));
 assert.equal(surroundSets(mpd).length,2);
 assert.ok(mpd.includes('<AdaptationSet contentType="audio" lang="deu"')); // the official commentary stays
});
test('encrypted HDR multiview takes the 5.1 of the feed whose sound plays, not of the first feed',async()=>{
 for(const [sound,expect] of [[1,2],[0,0]]){
  const h=harness({'https://video.formula1.com/vod2/master.m3u8':master51,'http://127.0.0.1:18765/stitch/g2':JSON.stringify({width:3840,height:3264,codecs:'hev1.2.4.L153.B0'})});
  h.ctx.MultiviewLayouts={layouts:{duo:{feeds:[2160,1080]}}};h.ctx.navigator={userAgent:'test'};
  const sdr='https://video.formula1.com/sdr/index.mpd';
  const feeds=[{url:'https://video.formula1.com/vod/master.m3u8',widevineManifestUrl:sdr,hdr:true,hdrEncrypted:true},
   {url:'https://video.formula1.com/vod2/master.m3u8',widevineManifestUrl:sdr,hdr:true,hdrEncrypted:true}];
  const built=await h.ctx.HdrStream.grid(feeds,'duo',{id:'g2',langs:{audio:'eng',text:''},audio:sound});
  assert.equal(surroundSets(built.mpd).length,expect);
  assert.equal(built.surround,expect);
 }
});
test('encrypted HDR adds no 5.1 when the app asks for none (a start with it failed, or the TV learned it fails)',async()=>{
 const r=await harness({'https://video.formula1.com/vod/master.m3u8':master51},{},{audio:'eng',text:'',surround:false}).built();
 assert.equal(surroundSets(r.mpd).length,0);assert.equal(r.surround,0);
});
test('the 5.1 never makes encrypted HDR miss its deadline: none when the preparation is already late',async()=>{
 // The master arrives 8.5 s into the preparation (of 12): no time is left for the optional 5.1, stereo HDR plays.
 const r=await harness({'https://video.formula1.com/vod/master.m3u8':master51},{},{audio:'eng',text:''},{'https://video.formula1.com/vod/master.m3u8':8500}).built();
 assert.equal(surroundSets(r.mpd).length,0);
 assert.ok(r.mpd.includes('width="3840" height="2160"'));
});
test('Spanish chosen as "spa" starts on the 5.1 that the HLS master calls "es"',async()=>{
 const m=master51.replace('LANGUAGE="spa"','LANGUAGE="es"');
 const official=mpd.replace('lang="deu"','lang="spa"');
 const xml=await harness({'https://video.formula1.com/vod/master.m3u8':m,'https://video.formula1.com/sdr/index.mpd':official},{},{audio:'spa',text:''}).build();
 const first=xml.indexOf('<AdaptationSet contentType="audio"');
 const set=xml.slice(first,xml.indexOf('</AdaptationSet>',first));
 assert.ok(set.includes('codecs="ac-3"')&&set.includes('lang="spa"'));
});
const otherKidInit=Buffer.from(init.toString('binary').replace(Buffer.from(hdrKid.replaceAll('-',''),'hex').toString('binary'),Buffer.from(kid.replaceAll('-',''),'hex').toString('binary')),'binary');
const otherClock=box('moof',box('traf',box('tfdt',Buffer.concat([Buffer.from([1,0,0,0]),(()=>{const b=Buffer.alloc(8);b.writeBigUInt64BE(89669832112000n);return b;})()]))));
for(const [name,more] of [
 ['declared on another key',{'https://video.formula1.com/vod/a/eng51.m3u8':playlist.replace(hdrKid,kid)}],
 ['on another key',{'https://video.formula1.com/vod/a/eng51.m3u8':playlist.replace(hdrKid,kid),'https://video.formula1.com/vod/a/init.mp4?sig=one&n=2':otherKidInit}],
 ['longer than the video',Object.fromEntries(['eng51','spa51'].map(n=>['https://video.formula1.com/vod/a/'+n+'.m3u8',playlist.replace('#EXT-X-ENDLIST','#EXTINF:5.76,\nv_102.m4s?sig=keep&n=2\n#EXT-X-ENDLIST')]))],
 ['a segment too short to write',{'https://video.formula1.com/vod/a/eng51.m3u8':playlist.replace('#EXTINF:5.76,\nv_101','#EXTINF:5.759999,\nv_101').replace('#EXT-X-ENDLIST','#EXTINF:0.000001,\nv_102.m4s?sig=keep&n=2\n#EXT-X-ENDLIST')}],
 ['at an invalid address',{'https://video.formula1.com/vod/master.m3u8':master51.replace('URI="a/spa51.m3u8"','URI="http://[bad"')}],
 ['on another clock',{'https://video.formula1.com/vod/a/v_100.m4s?sig=keep&n=2':otherClock}],
 ['unreachable',{'https://video.formula1.com/vod/a/spa51.m3u8':'not a playlist'}]
])test('encrypted HDR keeps the stereo commentary when the 5.1 is '+name,async()=>{
 const xml=await harness(Object.assign({'https://video.formula1.com/vod/master.m3u8':master51},more)).build();
 assert.equal(surroundSets(xml).length,0);
 assert.ok(!/PT(?!11\.52S)[\d.]+S"/.test(xml.match(/mediaPresentationDuration="[^"]*"/)[0]));   // the video's length
 assert.ok(xml.includes('<AdaptationSet contentType="audio" lang="eng"')&&xml.includes('width="3840" height="2160"'));
});

test('CDN redirects determine every relative manifest and media base',async()=>{
 const h=harness({}, {
  'https://video.formula1.com/vod/master.m3u8':'https://video.formula1.com/redirected/master.m3u8',
  'https://video.formula1.com/redirected/v/uhd.m3u8':'https://video.formula1.com/final/uhd.m3u8',
  'https://video.formula1.com/sdr/index.mpd':'https://video.formula1.com/final-sdr/index.mpd'
 });
 const xml=await h.build();
 assert.ok(h.calls.some(c=>c.url==='https://video.formula1.com/redirected/v/uhd.m3u8'));
 assert.ok(xml.includes('https://video.formula1.com/final/v_$Number$'));
 assert.ok(xml.includes('/s/'+Buffer.from('https://video.formula1.com/final-sdr/').toString('base64url')+'/'));
});

test('official commentary retains namespace bindings inherited from the source MPD',async()=>{
 const source=mpd.replace('<MPD ','<MPD xmlns:mspr="urn:microsoft:playready" ').replace('contentType="audio" lang="eng">','contentType="audio" lang="eng"><mspr:pro>public-metadata</mspr:pro>');
 const xml=await harness({'https://video.formula1.com/sdr/index.mpd':source}).build();
 assert.ok(xml.includes('xmlns:mspr="urn:microsoft:playready"'));
 assert.ok(xml.includes('<mspr:pro>public-metadata</mspr:pro>'));
});

test('encrypted HDR hands the official subtitle segments to the app instead of AVPlay',async()=>{
 const {subtitles}=await harness({}, {'https://video.formula1.com/sdr/index.mpd':'https://video.formula1.com/final-sdr/index.mpd'}).built();
 assert.deepEqual(plain(subtitles),[{lang:'eng',base:'https://video.formula1.com/final-sdr/',id:'_SUBS_1',bandwidth:'256',media:'a_$Number$.m4s',
  timescale:50000,offset:89669822112000,startNumber:1,duration:0,runs:[{t:89669822112000,d:288000,r:1}]}]);
});

// Live: F1 numbers HLS and DASH segments alike; segment 311353548 starts at the fragment's tfdt (89669822112000).
const livePlaylist=n=>`#EXTM3U\n#EXT-X-PLAYLIST-TYPE:EVENT\n#EXT-X-MAP:URI="init.mp4"\n#EXT-X-KEY:METHOD=SAMPLE-AES,KEYFORMAT="com.apple.streamingkeydelivery",URI="skd://${hdrKid}"\n`+
 [0,1,2,3,4].map(i=>`#EXTINF:5.76,\nseg_${n+i}.m4s?sig=keep&n=2`).join('\n')+'\n';
const liveMpd=(start=311353500)=>`<MPD xmlns="urn:mpeg:dash:schema:mpd:2011" type="dynamic" availabilityStartTime="2024-01-01T00:00:00Z"><Period id="p" start="PT10H"><AdaptationSet contentType="video">${cp}<SegmentTemplate timescale="50000" presentationTimeOffset="89669000000000" startNumber="${start}" media="v_$Number$.mp4" initialization="i.mp4"><SegmentTimeline><S t="89669808288000" d="288000" r="100"/></SegmentTimeline></SegmentTemplate><Representation id="v" codecs="avc1.4d4029"/></AdaptationSet><AdaptationSet contentType="audio" lang="eng">${cp}<SegmentTemplate timescale="48000" media="a_$Number$.mp4" startNumber="${start}"><SegmentTimeline><S t="1" d="276480" r="100"/></SegmentTimeline></SegmentTemplate><Representation id="a"/></AdaptationSet><AdaptationSet contentType="application" codecs="stpp" lang="eng"><SegmentTemplate timescale="50000" presentationTimeOffset="89669000000000" media="t_$Number$.mp4" startNumber="${start}"><SegmentTimeline><S t="89669808288000" d="288000" r="100"/></SegmentTimeline></SegmentTemplate><Representation id="_SUBS_1" bandwidth="256"/></AdaptationSet></Period></MPD>`;
function liveHarness(mpdText=liveMpd()){
 const ctx=vm.createContext({CmafDash,URL,Uint8Array,AbortController,setTimeout,clearTimeout,btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary'),fetch:async (url)=>{
  const body=url.endsWith('master.m3u8')?master:url.endsWith('.mpd')?mpdText:url.includes('.m3u8')?livePlaylist(311353547):url.includes('init.mp4')?init:frag;
  return {ok:true,url,text:async()=>body,arrayBuffer:async()=>Uint8Array.from(body).buffer};}});
 vm.runInContext(fs.readFileSync('app/js/hdr.js','utf8'),ctx);
 return ()=>ctx.HdrStream.live({url:'https://video.formula1.com/live/master.m3u8',widevineManifestUrl:'https://video.formula1.com/livesdr/index.mpd'});
}
test('live HDR: the HLG ladder on the official live timeline, with the HDR key and open-ended subtitles',async()=>{
 const {adaptation,subtitles}=await liveHarness()();
 assert.equal((adaptation.match(/<Representation /g)||[]).length,2);
 assert.ok(adaptation.includes('width="3840" height="2160"')&&adaptation.includes('width="1920" height="1080"'));
 assert.ok(adaptation.includes('presentationTimeOffset="89669000000000" startNumber="311353500"'));
 assert.ok(adaptation.includes('media="https://video.formula1.com/live/v/seg_$Number$.m4s?sig=keep&amp;n=2"'));
 assert.ok(adaptation.includes('initialization="https://video.formula1.com/live/v/init.mp4"'));
 assert.equal((adaptation.match(/<!--timeline-->/g)||[]).length,2);
 assert.ok(adaptation.includes(`cenc:default_KID="${hdrKid}"`));
 const sent=Buffer.from(/<cenc:pssh>([^<]+)/.exec(adaptation)[1],'base64');
 assert.ok(sent.includes(Buffer.from(hdrKid.replaceAll('-',''),'hex'))&&!sent.includes(Buffer.from(kid.replaceAll('-',''),'hex')));
 assert.ok(adaptation.includes('TransferCharacteristics" value="18"'));
 assert.ok(adaptation.startsWith('<AdaptationSet xmlns:cenc="urn:mpeg:cenc:2013" '),'binds the cenc prefix it uses');
 assert.equal(subtitles.length,1);
 assert.equal(subtitles[0].runs.at(-1).r,-1);
 assert.equal(subtitles[0].offset,89669000000000-36000*50000);
});
test('live HDR refuses timelines that do not line up, and a static source',async()=>{
 await assert.rejects(liveHarness(liveMpd(311353501))(),/timelines differ/);
 await assert.rejects(liveHarness(liveMpd().replace('type="dynamic"','type="static"'))(),/live layout/);
});

// Live 5.1 (Las Vegas 2026 Pre-Race Show): AC-3 renditions numbered and timed like the official 48 kHz audio, on the video's key.
const mdhd48=box('mdhd',Buffer.concat([Buffer.alloc(12),u32(48000),Buffer.alloc(8)]));
const tenc51=box('tenc',Buffer.concat([Buffer.from([1,0,0,0,0,0x19,1,0]),Buffer.from(hdrKid.replaceAll('-',''),'hex'),Buffer.from([16]),Buffer.alloc(16)]));
const enca=box('enca',Buffer.concat([Buffer.alloc(28),box('sinf',Buffer.concat([box('schm',Buffer.concat([Buffer.alloc(4),Buffer.from('cbcs'),u32(65536)])),box('schi',tenc51)]))]));
const init51=box('moov',box('trak',box('mdia',Buffer.concat([mdhd48,box('minf',box('stbl',box('stsd',Buffer.concat([Buffer.alloc(4),u32(1),enca]))))]))));
const astamp=Buffer.alloc(8);astamp.writeBigUInt64BE(86086398965760n+48n*276480n);
const frag51=box('moof',box('traf',box('tfdt',Buffer.concat([Buffer.from([1,0,0,0]),astamp]))));
const liveMaster51=master.replace('#EXT-X-STREAM-INF:BANDWIDTH=18000000,','#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_1",CHANNELS="6",NAME="eng",LANGUAGE="eng",URI="a/eng51.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=18384000,RESOLUTION=3840x2160,CODECS="hev1.2.4.L153.B0,ac-3",VIDEO-RANGE=HLG,AUDIO="audio_1"\nv/uhd.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=18000000,');
const liveAudioMpd=(t=86086398965760)=>liveMpd().replace('<SegmentTemplate timescale="48000" media="a_$Number$.mp4" startNumber="311353500"><SegmentTimeline><S t="1"','<SegmentTemplate timescale="48000" media="a_$Number$.mp4" startNumber="311353500"><SegmentTimeline><S t="'+t+'"');
function live51(mpdText=liveAudioMpd(),{masterText=liveMaster51,a51=livePlaylist(311353547).replace('init.mp4','a51init.mp4').replaceAll('seg_','a51_')}={},opts){
 const notes=[];
 const ctx=vm.createContext({CmafDash,URL,Uint8Array,AbortController,setTimeout,clearTimeout,Diag:{note:(k,d)=>notes.push([k,d])},btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary'),fetch:async (url)=>{
  const body=url.endsWith('master.m3u8')?masterText:url.endsWith('.mpd')?mpdText:url.includes('eng51.m3u8')?a51:url.includes('.m3u8')?livePlaylist(311353547):url.includes('a51init.mp4')?init51:url.includes('a51_')?frag51:url.includes('init.mp4')?init:frag;
  return {ok:true,url,text:async()=>body,arrayBuffer:async()=>Uint8Array.from(body).buffer};}});
 vm.runInContext(fs.readFileSync('app/js/hdr.js','utf8'),ctx);
 return ctx.HdrStream.live({url:'https://video.formula1.com/live/master.m3u8',widevineManifestUrl:'https://video.formula1.com/livesdr/index.mpd'},opts).then(r=>Object.assign(r,{notes}));
}
test('live HDR 5.1: AC-3 sets after the video, on the audio clock, the HDR key and through the helper',async()=>{
 const r=await live51();
 assert.equal(r.surround,1);
 const [video,audio]=r.adaptation.split('<!--audio-->');
 assert.ok(video.includes('hlg0')&&!video.includes('ac-3'));
 assert.ok(audio.startsWith('<AdaptationSet xmlns:cenc="urn:mpeg:cenc:2013" contentType="audio" mimeType="audio/mp4" lang="eng"'));
 assert.ok(audio.includes('codecs="ac-3"')&&audio.includes(`cenc:default_KID="${hdrKid}"`));
 assert.ok(audio.includes('timescale="48000" presentationTimeOffset="0" startNumber="311353500"'));
 assert.ok(audio.includes('media="http://127.0.0.1:18765/s/'+Buffer.from('https://video.formula1.com/live/a/').toString('base64url')+'/a51_$Number$.m4s?sig=keep&amp;n=2"'));
 assert.equal((audio.match(/<!--timeline-->/g)||[]).length,1);
});
test('live HDR 5.1 is optional: another clock, another key, none asked or none offered leave stereo',async()=>{
 for(const r of [await live51(liveAudioMpd(86086398965760-276480)),await live51(undefined,{a51:livePlaylist(311353547).replace('init.mp4','a51init.mp4').replaceAll('seg_','a51_').replace(hdrKid,kid)}),
  await live51(undefined,{},{surround:false}),await live51(undefined,{masterText:master})]){
  assert.equal(r.surround,0);assert.ok(!r.adaptation.includes('<!--audio-->')&&r.adaptation.includes('hlg0'));
 }
 for(const r of [await live51(undefined,{masterText:liveMaster51.replace('URI="a/eng51.m3u8"','URI="https://["')}),
  await live51(undefined,{a51:livePlaylist(311353547).replace('init.mp4','a51init.mp4').replaceAll('seg_','a51_').replaceAll('#EXTINF:5.76','#EXTINF:2.88')})]){
  assert.equal(r.surround,0,'a bad address or another cadence: stereo, and the video still');assert.ok(r.adaptation.includes('hlg0'));
 }
 const differs=await live51(liveAudioMpd(86086398965760-276480));
 assert.ok(differs.notes.some(([k,d])=>k==='hdr.surround_skipped'&&/timeline differs/.test(d.why)));
});

test('a clear HDR multiview gets the HLS master\'s WebVTT subtitles, on the video\'s timeline', async () => {
  const ctx = vm.createContext({ URL, CmafDash, setTimeout, clearTimeout, AbortController });
  vm.runInContext(fs.readFileSync('app/js/hdr.js', 'utf8'), ctx);
  const subs = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-MEDIA-SEQUENCE:1\n#EXTINF:5.760,\nindex_22_0_1.vtt\n#EXTINF:5.760,\nindex_22_0_2.vtt\n#EXT-X-ENDLIST\n';
  const io = { get: async (url) => {
    if (/fra/.test(url)) throw new Error('media request failed (403)');
    return { body: subs, url };
  } };
  const feed = { masterUrl: 'https://cdn/x/master.m3u8', master: [
    '#EXTM3U',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subtitles",NAME="fra_subtitle",DEFAULT=YES,LANGUAGE="fra",URI="fra/subs.m3u8"',
    '#EXT-X-MEDIA:TYPE=SUBTITLES,GROUP-ID="subtitles",NAME="eng_subtitle",DEFAULT=NO,LANGUAGE="eng",URI="eng/subs.m3u8"',
    '#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aac",LANGUAGE="eng",URI="a.m3u8"'].join('\n') };
  const round = (x) => Math.round(x * 1000) / 1000;
  const tracks = plain(await ctx.HdrStream.subtitleTracks(io, feed, 0.02)).map((t) =>
    Object.assign(t, { list: t.list.map((x) => Object.assign(x, { start: round(x.start), end: round(x.end) })) }));
  // French failed: left out, the other languages stay.
  assert.deepEqual(tracks, [{ lang: 'eng', vtt: true, offset: 0.02, timescale: 1, list: [
    { url: 'https://cdn/x/eng/index_22_0_1.vtt', start: 0.02, end: 5.78 },
    { url: 'https://cdn/x/eng/index_22_0_2.vtt', start: 5.78, end: 11.54 }] }]);
});

// São Paulo 2026: EXT-X-DISCONTINUITY in every playlist while the media timestamps run on to the tick.
test('encrypted HDR keeps a discontinuity whose media timestamps run on (one timeline), checking the segment after it',async()=>{
 const next=Buffer.alloc(8);next.writeBigUInt64BE(89669822112000n+288000n);
 const after=box('moof',box('traf',box('tfdt',Buffer.concat([Buffer.from([1,0,0,0]),next]))));
 const h=harness({'https://video.formula1.com/vod/v/uhd.m3u8':broken,'https://video.formula1.com/vod/v/v_101.m4s?sig=keep&n=2':after});
 const xml=await h.build();
 assert.ok(xml.includes('width="3840" height="2160"'));
 assert.ok(h.calls.some(c=>c.url==='https://video.formula1.com/vod/v/v_101.m4s?sig=keep&n=2'&&c.opts.headers.Range==='bytes=0-65535'),'the segment after the break, its head only');
});
test('a multiview of feeds with a discontinuity: built when their timestamps run on, refused when they jump',async()=>{
 const next=Buffer.alloc(8);next.writeBigUInt64BE(89669822112000n+288000n);
 const after=box('moof',box('traf',box('tfdt',Buffer.concat([Buffer.from([1,0,0,0]),next]))));
 const grid=(over)=>{
  const h=harness(Object.assign({'https://video.formula1.com/vod/v/uhd.m3u8':broken,'https://video.formula1.com/vod/v/hd.m3u8':broken,
   'http://127.0.0.1:18765/stitch/g3':JSON.stringify({width:3840,height:3264,codecs:'hev1.2.4.L153.B0'})},over));
  h.ctx.MultiviewLayouts={layouts:{duo:{feeds:[2160,1080]}}};h.ctx.navigator={userAgent:'test'};
  const lead={url:'https://video.formula1.com/vod/master.m3u8',widevineManifestUrl:'https://video.formula1.com/sdr/index.mpd',hdr:true,hdrEncrypted:true};
  return h.ctx.HdrStream.grid([lead,{url:'https://video.formula1.com/vod/master.m3u8',hdr:true}],'duo',{id:'g3',langs:{audio:'eng',text:''},audio:0});
 };
 const {mpd}=await grid({'https://video.formula1.com/vod/v/v_101.m4s?sig=keep&n=2':after});
 assert.ok(mpd.includes('<AdaptationSet contentType="video"'));
 await assert.rejects(grid({}),/discontinuity/);
 // The second feed's own clock jumping at the break (each feed is checked, not only the first).
 await assert.rejects(grid({'https://video.formula1.com/vod/v/v_101.m4s?sig=keep&n=2':after,'https://video.formula1.com/vod/v/hd.m3u8':broken.replaceAll('v_10','w_10')}),/timestamps jump/);
 // Feeds whose breaks differ can't share one timeline.
 await assert.rejects(grid({'https://video.formula1.com/vod/v/v_101.m4s?sig=keep&n=2':after,'https://video.formula1.com/vod/v/hd.m3u8':playlist}),/differ in discontinuities/);
});
