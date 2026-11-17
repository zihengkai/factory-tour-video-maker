# 音频素材授权清单

来源：Mixkit Stock（https://mixkit.co），Mixkit Stock Music Free License / Sound Effects Free License，可商用、免署名。
本目录的 MP3 由 `node server/setup-audio.mjs` 下载/派生，不入版本库；换机器执行同一条命令即可复现。

## BGM

- Motivating Mornings — Ahjay Stelino（Corporate）｜bgm-motivating-mornings.mp3｜96.2s｜https://assets.mixkit.co/music/33/33.mp3
- Close Up — Michael Ramir C.（Corporate Music）｜bgm-close-up.mp3｜95.1s｜https://assets.mixkit.co/music/1167/1167.mp3
- Infinity — Arulo（Corporate Music）｜bgm-infinity.mp3｜102.9s｜https://assets.mixkit.co/music/440/440.mp3
- Stylz — Ahjay Stelino（Corporate Music）｜bgm-stylz.mp3｜99.6s｜https://assets.mixkit.co/music/102/102.mp3
- Your Breath — Eugenio Mininni（Corporate Music）｜bgm-your-breath.mp3｜236.1s｜https://assets.mixkit.co/music/634/634.mp3
- It's Love — Michael Ramir C.（Corporate Music）｜bgm-its-love.mp3｜96.6s｜https://assets.mixkit.co/music/834/834.mp3
- PlaceIt World 01 — Lily J（Corporate Music）｜bgm-placeit-world.mp3｜96.0s｜https://assets.mixkit.co/music/724/724.mp3
- Running Out of Time — Ahjay Stelino（Corporate Music）｜bgm-running-out-time.mp3｜96.5s｜https://assets.mixkit.co/music/77/77.mp3
- Lo-Fi 04 — Lily J（Corporate Music）｜bgm-lofi-04.mp3｜164.4s｜https://assets.mixkit.co/music/766/766.mp3
- Digital Clouds — Alejandro Magana (A. M.)（Chillout）｜bgm-digital-clouds.mp3｜101.0s｜https://assets.mixkit.co/music/175/175.mp3
- Curiosity — Diego Nava（Chillout）｜bgm-curiosity.mp3｜100.1s｜https://assets.mixkit.co/music/480/480.mp3

## 音效母带

- Whoosh 1489（whoosh）｜sfx-whoosh.mp3｜2.3s｜https://assets.mixkit.co/active_storage/sfx/1489/1489-preview.mp3
- Transition 166（transition）｜sfx-transition.mp3｜0.8s｜https://assets.mixkit.co/active_storage/sfx/166/166-preview.mp3
- Impact 498（impact）｜sfx-impact.mp3｜3.5s｜https://assets.mixkit.co/active_storage/sfx/498/498-preview.mp3

## 派生变体（本机 ffmpeg 处理，无新增第三方素材）

- sfx-whoosh-deep.mp3 ← sfx-whoosh.mp3｜whoosh 压低频，做章节切的厚重感｜`lowpass=f=700,volume=1.02`
- sfx-whoosh-soft.mp3 ← sfx-whoosh.mp3｜whoosh 收薄，轻扫过｜`lowpass=f=2400,volume=0.62`
- sfx-whoosh-short.mp3 ← sfx-whoosh.mp3｜whoosh 截短，卡点用｜`atrim=0:1.15,asetpts=PTS-STARTPTS,afade=t=out:st=0.95:d=0.2,volume=0.9`
- sfx-transition-deep.mp3 ← sfx-transition.mp3｜transition 低沉版｜`lowpass=f=520,volume=1.02`
- sfx-transition-soft.mp3 ← sfx-transition.mp3｜transition 轻软版，卡片入场用｜`lowpass=f=2600,volume=0.7`
- sfx-impact-low.mp3 ← sfx-impact.mp3｜impact 下沉版，收尾用｜`lowpass=f=380,asetrate=48000*0.85,aresample=48000,volume=1.0`
- sfx-riser.mp3 ← sfx-whoosh.mp3｜反向 whoosh，做上扬铺垫（可选）｜`areverse,lowpass=f=2000,volume=0.95`
