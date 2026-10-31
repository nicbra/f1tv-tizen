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
function harness(overrides={}, redirects={}){
 const calls=[];
 const ctx=vm.createContext({CmafDash,URL,Uint8Array,AbortController,setTimeout,clearTimeout,btoa:s=>Buffer.from(s,'binary').toString('base64'),atob:s=>Buffer.from(s,'base64').toString('binary'),fetch:async (url,opts={})=>{calls.push({url,opts});let body=url.endsWith('master.m3u8')?master:url.endsWith('.mpd')?mpd:url.includes('.m3u8')?playlist:url.includes('init.mp4')?init:frag;body=overrides[url]??body;return {ok:true,url:redirects[url]||url,text:async()=>body,arrayBuffer:async()=>Uint8Array.from(body).buffer};}});
 vm.runInContext(fs.readFileSync('app/js/hdr.js','utf8'),ctx);
 const built=()=>ctx.HdrStream.build({url:'https://video.formula1.com/vod/master.m3u8',widevineManifestUrl:'https://video.formula1.com/sdr/index.mpd'},{audio:'deu',text:'eng'});
 return {calls,built,build:()=>built().then(r=>r.mpd)};
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
for(const [name,url,body] of [
 ['discontinuity','https://video.formula1.com/vod/v/uhd.m3u8',playlist.replace('#EXTINF:','#EXT-X-DISCONTINUITY\n#EXTINF:')],
 ['key mismatch','https://video.formula1.com/vod/v/uhd.m3u8',playlist.replace(hdrKid,kid)],
 ['unmatched clock','https://video.formula1.com/sdr/index.mpd',mpd.replaceAll('presentationTimeOffset="89669822112000"','presentationTimeOffset="89669812112000"')],
 ['dynamic source','https://video.formula1.com/sdr/index.mpd',mpd.replace('type="static"','type="dynamic"')],
 ['no HLG','https://video.formula1.com/vod/master.m3u8',master.replaceAll('VIDEO-RANGE=HLG','VIDEO-RANGE=SDR')]
])test('encrypted HDR rejects '+name+' for safe SDR recovery',async()=>{await assert.rejects(harness({[url]:body}).build());});


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
