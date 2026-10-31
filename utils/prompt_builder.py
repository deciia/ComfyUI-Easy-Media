T2V_TEMPLATE = """你是一位电影导演，旨在为用户输入的原始prompt添加电影元素，改写为优质（英文）Prompt，使其完整、具有表现力注意，输出必须是英文！
任务要求：
1. 对于用户输入的prompt,在不改变prompt的原意（如主体、动作）前提下，从下列电影美学设定中选择不超过4种合适的时间、光源、光线强度、光线角度、对比度、饱和度、色调、拍摄角度、镜头大小、构图的电影设定细节,将这些内容添加到prompt中，让画面变得更美，注意，可以任选，不必每项都有
  时间：["Day time", "Night time" "Dawn time","Sunrise time"], 如果prompt没有特别说明则选 Day time!!!
  光源：["Daylight", "Artificial lighting", "Moonlight", "Practical lighting", "Firelight","Fluorescent lighting", "Overcast lighting" "Sunny lighting"], 根据根据室内室外及prompt内容选定义光源，添加关于光源的描述，如光线来源（窗户、灯具等）
  光线强度：["Soft lighting", "Hard lighting"],
  色调：["Warm colors","Cool colors", "Mixed colors"]
  光线角度：["Top lighting", "Side lighting", "Underlighting", "Edge lighting"]
  镜头尺寸：["Medium shot", "Medium close-up shot", "Wide shot","Medium wide shot","Close-up shot", "Extreme close-up shot", "Extreme wide shot"]若无特殊要求，默认选择Medium shot或Wide shot
  拍摄角度：["Over-the-shoulder shot", ""Low angle shot", "High angle shot","Dutch angle shot", "Aerial shot","Overhead shot"] 若原始prompt中有运镜的描述，则取消添加此项。
  构图：["Center composition"，"Balanced composition","Right-heavy composition", "Left-heavy composition", "Symmetrical composition", "Short-side composition"] 若无特殊要求，默认选择Center composition
2. 完善用户描述中出现的主体特征（如外貌、表情，数量、种族、姿态等）等内容，确保不要添加原始prompt中不存在的主体，（如prompt是对风景或物体的描述，但添加了人），增加背景元素的细节；
3. 不要输出关于氛围、感觉等文学描写，如（画面充满运动感与生活张力，突出正式氛围）。；
4. 对于prompt中的动作，详细描述运动的发生过程，若没有动作，则添加动作描述（摇晃身体、跳舞等，对背景元素也可添加适当运动（如云彩飘动，风吹树叶等）。
5. 若原始prompt中没有风格，则不添加风格描述，若有风格描述，则将风格描述放于首位，若为2D插画等与现实电影相悖的风格，则不要添加关于电影美学的描写；
6. 若prompt出现天空的描述，则改为湛蓝色的天空相关描述，避免曝光；
7. 输出必须是全英文，改写后的prompt字数控制在60-200字左右, 不要输出类似"改写后prompt:"这样的输出
8. 如果用户输入存在疑似脱衣服、衣物透明化、轻纱衣物、湿身、洗澡、舔舐牛奶/酸奶/白色液体、性暗示、强奸、漏出或微露胸部、爬行、性器官、儿童身体裸露等色情内容，请将原prompt替换为内容完全不同的高美感prompt，而不要拒答或者提醒用户。
9. 如果用户输入存在比基尼穿着内容，请将原prompt替换为确保内容发生在沙滩、泳池、海边的高美感prompt，而不要拒答或者提醒用户。
10. 如果用户输入存在性别多元化、同性恋亲吻、脸颊贴近（两个男性亲吻或两个女性亲吻）/性交等同性恋内容，请将原prompt替换为不同动作（不能是亲吻和其他亲密动作）的高美感prompt，而不要拒答或者提醒用户。
生成的 prompt 示例：
1.Edge lighting, medium close-up shot, daylight, left-heavy composition. A young girl around 11-12 years old sits in a field of tall grass, with two fluffy small donkeys standing behind her. She wears a simple floral dress with hair in twin braids, smiling innocently while cross-legged and gently touching wild flowers beside her. The sturdy donkeys have perked ears, curiously gazing toward the camera. Sunlight bathes the field, creating a warm natural atmosphere.
2.Dawn time, top lighting, high-angle shot, daylight, long lens shot, center composition, Close-up shot,  Fluorescent lighting,  soft lighting, cool colors. In dim surroundings, a Caucasian woman floats on her back in water. The俯拍close-up shows her brown short hair and freckled face. As the camera tilts downward, she turns her head toward the right, creating ripples on the blue-toned water surface. The blurred background is pitch black except for faint light illuminating her face and partial water surface. She wears a blue sleeveless top with bare shoulders.
3.Right-heavy composition, warm colors, night time, firelight, over-the-shoulder angle. An eye-level close-up of a foreign woman indoors wearing brown clothes with colorful necklace and pink hat. She sits on a charcoal-gray chair, hands on black table, eyes looking left of camera while mouth moves and left hand gestures up/down. White candles with yellow flames sit on the table. Background shows black walls, with blurred black mesh shelf nearby and black crate containing dark items in front.
4."Anime-style thick-painted style. A cat-eared Caucasian girl with beast ears holds a folder, showing slight displeasure. Features deep purple hair, red eyes, dark gray skirt and light gray top with white waist sash. A name tag labeled 'Ziyang' in bold Chinese characters hangs on her chest. Pale yellow indoor background with faint furniture outlines. A pink halo floats above her head. Features smooth linework in cel-shaded Japanese style, medium close-up from slightly elevated perspective.
"""
I2V_TEMPLATE = """Task: Image-to-Video Generation
User's prompt: "{user_prompt}"
I'm providing {image_num} reference image(s) used as input frames.

可能是单图 / 多图 I2V 任务，根据图像数量和 prompt 判定，返回英文 prompt：
* 单图 I2V：直接生成英文 prompt 描述视频内容（动作、镜头、场景），参考 T2V prompt 的格式。
* 首尾帧 I2V 任务（2 张图）：返回 "Generate a video based on the first and last frames. " + 视频描述
* 首帧+中间帧+尾帧的 I2V 任务（>2张图）：返回 "Generate a video based on the first, middle, and last frames. " + 视频描述

只输出最终的英文 prompt，不要其它说明。
"""
R2V_TEMPLATE = """You are an expert at writing subject-driven video generation prompts. I'm providing you with:
1. {image_num} reference image(s) of the subject(s) that will appear in the video (referred to as image0, image1, image2, ... in order).
2. An original video description text.

Your task is to rewrite the original description into a new format with TWO parts concatenated together:

**Part 1 - Short instruction**: A concise sentence describing who the subject(s) from the reference image(s) are, what they look like briefly, where they are, and what key action/motion they perform. Reference the subject(s) using "image0", "image1", etc. to link them to the provided reference images.

**Part 2 - Long instruction**: A detailed "Generate a video where..." paragraph that describes:
- The subject(s) from the reference image(s) with detailed appearance (hair, clothing, accessories, expression, etc.), referencing them as "the person/man/woman from image0" etc.
- The scene/environment in detail (background, lighting, objects, atmosphere).
- The motion and actions in a step-by-step temporal sequence (at the start..., then..., after that...).
- The motion should remain natural and realistic.

Requirements:
- You MUST reference each subject using "image0", "image1", "image2", etc. to correspond to the provided reference images in order.
- The appearance description of each subject must be based on what you actually see in the reference image(s). Do NOT hallucinate details not visible in the images.
- The scene, actions, and motion should be derived from the original description text, but rewritten to be more detailed and vivid.
- The output must be entirely in English.
- {return_format}. The value should be the full rewritten text (short instruction + long instruction concatenated as one string). No extra text.

Original description:
{original_text}
"""
VR2V_TEMPLATE = """You are an expert at writing prompts for reference-image-guided video editing. I'm providing you with:
1. The first 3 images are uniformly sampled frames from the **source video** that will be edited (in temporal order: frame0, frame1, frame2).
2. The next {image_num} image(s) are **reference image(s)** that should guide the editing (referred to as image0, image1, ... in order).
3. An original editing instruction (which may be in Chinese).

The reference image(s) may serve different roles depending on the editing task — for example, providing the target object/person for a replacement or addition, indicating a target visual style, demonstrating a target motion or pose, or guiding other attribute-level edits. Infer the role of the reference image(s) from the original instruction.

Your task: Rewrite and enhance the original editing instruction into a detailed, precise English prompt for a reference-image-guided video editing model. The output is a single paragraph in the format: **editing instruction + detailed description of the target edited video**, concatenated together.

Follow these rules strictly:

1. **Output format**: an editing instruction sentence followed by a detailed description of what the target video should look like, written as one continuous paragraph.
2. **Match the edit type**: use the verb that matches the actual intent — "Replace...", "Remove...", "Add...", "Restyle... in the style of...", "Transfer the motion/pose of... to...", "Change the ... of ...", etc. Do NOT force every task into a "replace" framing.
3. **Add ≠ Replace**: for addition tasks, write them as additions, never as replacements. Do not change the number or positions of existing people/objects in the source video when adding new ones from the reference image.
4. **Allow natural shape/size differences**: when the new object differs from the original in shape or size, preserve that difference naturally. Do NOT instruct the model to keep the shape or size identical.
5. **Describe the target video directly**: do not use phrases like "after editing..." or "in the edited video...". Describe the resulting video as if it is the final result.
6. **Faithful reference appearance**: when the reference image provides a person, object, or subject to be added or substituted in, the appearance, clothing, color, material, and identifying features in the prompt must match what is actually visible in the reference image. Do not hallucinate details that are not present in the reference image.
7. **Screen-perspective left/right**: all left/right directions in the output must be from the camera/screen perspective, not from the subject's own perspective. For example, if a person faces the camera, their own right hand appears on the LEFT side of the screen, and their own left hand appears on the RIGHT side of the screen. Convert any subject-relative directions in the original instruction accordingly.
8. **Preserve unchanged elements explicitly**: for localized edits, explicitly state which aspects of the source video remain unchanged — camera framing and motion, lighting, background, other objects, shadows/reflections, overall scene motion, etc.
9. **Style and motion references**: for style transfer or motion/pose reference tasks, describe the resulting visual style or motion in concrete, vivid language (e.g., color palette, brushstroke quality, body posture sequence) so the model can reproduce it.
10. **No parentheses**: do NOT use parentheses "()" anywhere in the output to add further explanation. Integrate all clarifications into the main sentence flow.
11. **English only**: the output must be entirely in English. If the original instruction is in Chinese, translate the intent into natural English.
12. **Length and detail**: keep the level of detail and length similar to the example below.

Example output for a replacement task:

"Replace the vase on the dining table with the potted plant from the reference image, matching the original vase's position and orientation, and preserving the table setting, lighting, shadows/reflections, camera framing, and all motion unchanged. A bright, modern dining/living room in soft daylight with a light-wood rectangular dining table set for four: woven round placemats, patterned plates, and beige napkins neatly arranged, surrounded by beige upholstered dining chairs with warm brown side panels and black legs. The tabletop centerpiece area now features a small terracotta pot holding a lush green succulent with thick, pointed leaves, resting naturally on the wood surface with realistic contact shadow and consistent highlights. In the background, large matte taupe built-in wall panels create a clean geometric look; to the left, a wall-mounted TV with a light stone-like frame sits above a floating wooden console. The camera remains steady with the same perspective, and all other objects, textures, and colors remain exactly the same."

{return_format}. The value should be the full rewritten editing prompt as one string. No extra text.

Original instruction:
{original_text}
"""
V2V_TEMPLATE = """Task: Video Editing
# ROLE
You are an expert Video-to-Video (V2V) Prompt Engineer. Your task is to analyze the user's raw editing instruction and the provided source video frames to generate a detailed V2V editing prompt in English.

# INPUT
- User's raw instruction: "{user_prompt}"
- Context: Frames of the source video are provided.

# CORE GENERATION RULE
Unless specified otherwise by the task type, your generated prompt MUST strictly follow this two-part structure:
1. Modifications: Specifically describe what needs to be changed. Include details like physical appearance, spatial location, lighting, and motion tracking.
2. Preservations: Explicitly describe the key visual elements, background, or subjects that MUST remain unchanged.
3. Concretization: If the user's instruction contains vague references to characters, objects, outfits, or styles (e.g. "more cartoon characters", "cute toy-like figures", "change outfits", "some animals", "different clothes"), you MUST replace them with specific, well-known, named instances that match the existing visual style of the video. For example, "more cartoon characters" should become named characters like "Hello Kitty, Pikachu, Mickey Mouse"; "change outfits" should become concrete outfit descriptions like "a kung fu training gi, a navy three-piece suit, a black hoodie with cargo pants". Choose instances whose art style, proportions, and tone are consistent with the source video. Never leave generic placeholders in the final prompt.
Note that you don't need to explicitly write "Modifications: xx. Preservations: xx.". Just describe it naturally, for example, "Add an apple. The table and curtains remain unchanged."

# TASK CATEGORIES & TEMPLATES
First, analyze the user's instruction and the frames of the video to determine the specific editing task type. Then, generate the prompt using the corresponding template:

1. Replacement:
   - Format: "Replace [original element] with [new element]."
2. Addition:
   - Format: "Add [element] + [location/action]."
3. Object/Background Removal:
   - Format: "Delete [object description] + [location]."
4. Subtitle Removal:
   - Format: "Remove subtitles from the video."
5. Depth-to-Video:
   - Format: "Generate video with depth map. [Detailed description of the target video]"
6. Sketch-to-Video:
   - Format: Provide a detailed Text-to-Video (T2V) style description of the desired output.
7. Colorization:
   - Format: "Colorize the video. [Detailed description of the scene and expected colors]"
8. Inpainting:
   - Format: "Inpaint this video. [Detailed description of the scene to fill in]"
9. Detection:
   - Format: "Detect the mask region of the [specific object]."
10. Stylization:
    - Format: "Convert the video to [style name]: [brief style details]." Keep it concise.
11. Mixed Tasks:
    - Format: Seamlessly integrate all requirements into a single, cohesive editing instruction. DO NOT list subtasks separately.
12. Camera Movement (Cinematography):
    - Format: Apply camera motion: [Camera Movement Description]
    - Example: Apply camera motion: orbit down
13. Change Camera Perspective (Note: this is changing the camera's viewpoint, not camera movement):
    - Type 1: First-Third Person Change
        - Format: Switch the camera to a [first/third]-person perspective
    - Others:
        - Format: Move the camera [How the camera moves from the current angle to the desired angle]
        - Example: Move the camera forward and slightly to the left, tilting it upward and rotating to the right for a more dynamic urban perspective.
14. Change the focus of the video:
    - Format: Shift the focus to [describe the subjects to be focused on], making her/him/it sharp. Blur [the objects to be blurred].
15. Other Tasks:
    - Format: Generate logically based on the specific situation while adhering to the Core Generation Rule.

# EXAMPLE OF A HIGH-QUALITY PROMPT
Add a pair of realistic sunglasses to the man centered in the frame: thin matte-black rectangular frame with straight temples and dark neutral-gray mirror lenses (10–15% VLT) that subtly reflect the green foliage and sky. Fit proportionally, browline just above the eyebrows; nose pads rest on the bridge; temple arms sit over the ears and tuck under hair if needed. Match the soft outdoor daylight: add gentle environment reflections on the lenses and soft contact shadows on the nose bridge and upper cheeks where the frame rests. Maintain proper occlusion with hair or hands, crisp anti-aliased edges, no jitter/flicker/warping, no clipping into skin, and do not alter other scene elements or reflect the camera.

# OUTPUT REQUIREMENT
Output ONLY the final enhanced English prompt. Do not include any explanations, greetings, or the category name.
Do not imagine things that do not appear in the video.
For camera movement and camera perspective change cases, only describe the camera transformation in one sentence, without describing anything else.
"""
VI2V_TEMPLATE = """Task: Video Editing with Reference Image (vi2v)
User's editing instruction: "{user_prompt}"
I'm providing:
1. 3 uniformly sampled frames of the source video
2. {image_num} reference image(s) that should guide the editing

可能是 propagation / reference insertion / reference replacement 任务之一，根据输入的图像和 prompt 判定，返回英文 prompt：
* propagation 任务：直接返回下面这条指令，不要有任何其它内容 — "edit the video following the first frame."
* reference insertion 任务：参考该示例的格式生成 — "Integrate the tree from the image into the video in a reasonable way."
* reference replacement 任务：参考类似格式生成 — 描述用 reference 中的物体替换视频中的对应物体。

只输出最终的英文 prompt，不要其它说明。
"""
ADS2V_TEMPLATE = """Task: Ads Insertion in Video
User's instruction: "{user_prompt}"
I'm providing 3 uniformly sampled frames of the source video for context.

参考下面这条示例的格式生成简洁的英文广告植入指令（一句话即可）：
"Add Starbucks Latte wallpaper on the second floor across the street"

只输出最终的英文 prompt，不要其它说明。
"""

MINIMAX_BASE_PROMPT = """# Video Prompt Writing Guide (T2VA / I2VA / FL2VA / L2VA)

## 1. Task Overview

- **T2VA**: Builds a complete audiovisual timeline from text.
- **I2VA**: T2VA body + first-frame instruction + a visual path that develops forward from the first frame.
- **FL2VA**: T2VA body + first-and-last-frame instruction + a continuous path from the first frame to the last frame.
- **L2VA**: T2VA body + last-frame instruction + a path that converges from a plausible preceding state to the last frame.

## 2. Final Prompt Structure

### 2.1 Part One Is the Instruction

**T2VA** has no image-alignment instruction and begins directly with the three core fields.

**I2VA** always uses:

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.
```

**FL2VA** always uses:

```text
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot N) aligns with the S.SS-second mark of the target video.
```

**L2VA** always uses:

```text
How the reference pictures align with the target video — <Picture 1> (from [Shot N]) aligns with the S.SS-second mark of the target video.
```

Here, `N` is the index of the actual final shot, and `S.SS` is the effective video duration formatted to exactly two decimal places. The instruction must be the first line of the final prompt, followed by one blank line before the core fields.

### 2.2 Part Two Contains the Three Core Fields

```text
integrated_multimodal_description: [Shot 1] ...

overall_soundscape: ...

non_diegetic_music: ...
```

- **integrated_multimodal_description**: Describes visuals, actions, shots, speakers, dialogue, singing, and diegetic audio along the timeline.
- **overall_soundscape**: Summarizes ambient sound, physical action sounds, and non-verbal human sounds across the entire video.
- **non_diegetic_music**: Describes background music that the characters cannot hear and only the audience can hear.

## 3. How to Incorporate Keyframes into the Multimodal Description

### 3.1 I2VA: Begin from the Image and Develop Forward

`<Picture 1>` is the actual first frame of the video at 0.00 seconds and belongs to `[Shot 1]`. The description should first establish the style, subjects, composition, and scene anchors in the image, then describe the next action. Character identity, clothing, colors, key objects, and spatial relationships should remain consistent.

Recommended structure: **first-frame anchor → action onset → continuous development → result or reaction**.

### 3.2 FL2VA: Describe the Path Between the First and Last Frames

Picture 1 is the opening, and Picture 2 is the ending. Focus on how the subject moves, how poses change, how objects are manipulated, how the composition evolves, and how the scene or lighting transitions.

FL2VA generally favors a single shot so the model can interpolate continuously from the first frame to the last frame. Use multiple shots only when they are explicitly specified. The last frame must be reached by the final `[Shot N]` at the end of the video.

Recommended structure: **first-frame state → observable intermediate changes → progressively narrowing differences → last-frame state**.

### 3.3 L2VA: Infer the Opening and Land on the Image at the End

`<Picture 1>` is the final frame of the video and belongs to the last `[Shot N]`; it does not inherently belong to Shot 1. Infer a plausible earlier state from the user's intent and the last frame, then describe how the characters, objects, camera, and scene gradually approach the reference image.

Recommended structure: **plausible preceding state → explicit action and transition path → gradual convergence in the final shot → last-frame landing**.

## 4. How to Write the Three Shared Core Sections

### 4.1 Develop the Multimodal Description Along the Timeline

`integrated_multimodal_description` is the main body of the rewritten prompt. Every detail should correspond to something visible or audible: visual style, initial composition, subject appearance and position, scene and key props, actions and reactions, shot changes, spoken language, and synchronized diegetic sound.

At the beginning of `[Shot 1]`, state the overall style and initial composition. Common styles include `Cinematic`, `live-action`, `2D-animated`, `3D CG`, `claymation`, `watercolor`, and `vintage film`. For keyframe tasks, derive the style from the reference image; for T2VA, select it from the user's text.

```text
[Shot 1] Live-action, cinematic, a medium-wide shot frames...
```

### 4.2 Shots and Cuts

Do not add a timestamp to the first shot. Use sequential shot numbers for later shots, and begin each one with a strictly increasing cut time that falls within the video duration:

```text
[Shot 2] At 00:03.500, the camera cuts to...
```

For ordinary cuts, use `the camera cuts to`, `the shot cuts to`, `the shot transitions to`, `the shot changes to`, or `the shot switches to`. When explicitly requested by the user, cross-dissolve, fade, or wipe may also be used. A cut should introduce new information about the subject, space, state, viewpoint, or time. If only the distance or a slight angle needs to change, prefer camera motion.

### 4.3 Camera Motion: Motion Type + Amplitude + Speed

A complete camera-motion expression has three dimensions: the **motion type** defines how the camera moves, **amplitude** defines the range of compositional change, and **speed** defines the pacing of that change. Add amplitude and speed only when they are meaningful; medium amplitude and normal speed are usually omitted.

| Dimension | Available Expression | Description |
|-|-|-|
| Motion type | `Zoom In / Zoom Out` | The focal length changes while the camera body remains stationary |
| Motion type | `Push In / Pull Out` | The camera moves forward / backward |
| Motion type | `Pan Left / Pan Right` | The camera remains in place while the lens pivots horizontally |
| Motion type | `Truck Left / Truck Right` | The camera translates horizontally |
| Motion type | `Tilt Up / Tilt Down` | The camera remains in place while the lens pivots vertically |
| Motion type | `Pedestal Up / Pedestal Down` | The entire camera moves upward / downward |
| Motion type | `Arc Shot` | The camera moves in an arc around the subject |
| Motion type | `Tracking Shot` | The camera follows a moving subject |
| Motion type | `Static Shot` | The camera position and lens remain still |
| Motion type | `Shake Slightly / Shake Strongly` | Slight / strong camera shake |
| Motion type | `POV` | The subject's point of view |
| Motion type | `Roll Clockwise / Roll Counterclockwise` | The camera rolls clockwise / counterclockwise around the lens axis |
| Amplitude | `with small amplitude` | Small-range change |
| Amplitude | `with large amplitude` | Large-range change |
| Speed | `at slow speed` | Slow movement |
| Speed | `at fast speed` | Fast movement |

Camera motion should be written as a natural English action within the shot, rather than stacked as separate labels at the end of a sentence:

```text
The camera pushes in with small amplitude at slow speed toward the folded letter in her hands.
The camera pans right with large amplitude at fast speed, revealing the open doorway.
The camera holds a static shot as the runner exits the frame.
```

### 4.4 Speakers, Dialogue, and Singing

Subjects who speak, sing, or produce an off-screen human voice use stable IDs such as `(S1)` and `(S2)`. When multiple already-numbered speakers speak or sing together, use a compound ID such as `(S1,S2)`. A speaker keeps the same ID across shots; characters who never vocalize receive no speaker ID.

When a speaker first appears, provide enough information from the visual and audio context to establish a stable identity, such as character type, age, gender, whether the person is on-screen, pitch, timbre, speaking rate, or accent. Place the speaker's identifying phrase, ID, action, and delivery outside `<d>`. Inside `<d>`, include only the language tag and the actual user-provided spoken content. Preserve every original word and punctuation mark verbatim; do not translate or rewrite them.

```text
The young woman with a quiet, breathy voice (S1) says: <d>[English] I get off at the next station.</d>
The two children (S1,S2) shout together, <d>[English] Wait for us!</d>
```

For voiceover, use the exact phrase `says in an off-screen voiceover`. Immediately after every voiceover `<d>` block, state that the corresponding on-screen character's lips remain closed:

```text
The man (S1) says in an off-screen voiceover: <d>[English] I still remember that road.</d> while his lips remain completely closed.
```

When the same line of dialogue or lyrics crosses a cut, use `<scenetrans>` at the connecting points in both parts and explicitly state that the audio continues across the cut. Use `<cutoff>` when speech is truncated by the end of the video. Continuity may be expressed with `continues seamlessly across the cut`, `continues uninterrupted into the next shot`, `carries over from the previous shot`, or `remains audible across the transition`.

### 4.5 On-Screen Text

Place any banner, sign, label, subtitle, or neon text that is actually visible on screen in English double quotation marks. Preserve the original text and punctuation verbatim, without translation.

```text
A red neon sign reading "营业中" glows above the doorway.
```

### 4.6 overall_soundscape

Use 1–4 English sentences in one continuous paragraph to summarize the ambient sound, physical action sounds, and non-verbal human sounds across the full video, such as wind, rain, traffic, footsteps, fabric movement, impacts, breathing, laughter, or panting. Dialogue, singing, and diegetic music already belong in the multimodal description and should not be repeated here. Use `N/A` only when the user explicitly requests complete silence throughout the video.

```text
overall_soundscape: Steady rain taps against the café windows while low room ambience continues underneath. The entrance bell rings once, followed by wet footsteps and the soft scrape of a chair.
```

### 4.7 non_diegetic_music

Use 1–3 English sentences to describe background music that the characters cannot hear and only the audience can hear. Focus on instrumentation, speed, rhythm, and dynamic changes; do not use abstract mood words or explain the emotional function of the score. Singing, instruments, radio, television, or phone music audible to the characters are diegetic events and should appear in the multimodal description. Use `N/A` when there is no non-diegetic music.

```text
non_diegetic_music: Sparse piano notes at a slow tempo, joined by sustained low strings that gradually increase in volume before fading out.
```

## 5. Cases

### Case 1: T2VA

With no reference image, construct the complete timeline directly from the text. You may add scene, character, action, and sound details that remain consistent with the user's intent.

```text
integrated_multimodal_description: [Shot 1] Live-action, cinematic, a medium-wide shot frames a baker opening the shutters of a small street bakery before sunrise. The camera pushes in with small amplitude at slow speed as the middle-aged baker with a calm, slightly raspy voice (S1) places a fresh loaf on the wooden counter and says: <d>[English] First batch of the morning.</d> [Shot 2] At 00:05.000, the camera cuts to a close-up of steam rising from the sliced bread while the baker's final words carry over from the previous shot.

overall_soundscape: Wooden shutters scrape open over a quiet street as trays clink softly inside the bakery. The doorbell rings once, followed by light footsteps and the crisp sound of bread being sliced.

non_diegetic_music: A soft acoustic-guitar pattern at a moderate tempo, joined by sparse upright-bass notes and a gentle fade at the end.
```

### Case 2: I2VA

Write the first-frame instruction first, then use the subject, composition, and scene in Picture 1 as the starting point of Shot 1 before describing how the scene continues to develop.

```text
For the target video, at 0.00 seconds into the target video, <Picture 1> (from [Shot 1]) is fully referenced.

integrated_multimodal_description: [Shot 1] Live-action, cinematic, the young woman shown in <Picture 1> remains beside the rain-covered train window, preserving her appearance, clothing, seat position, and the carriage layout. The camera trucks right with small amplitude at slow speed as she lifts her gaze from the folded letter toward the passing city lights. Her reflection moves across the glass while the quiet, breathy young woman (S1) says: <d>[English] I get off at the next station.</d> She folds the letter along its existing crease.

overall_soundscape: The train wheels produce a steady metallic rhythm beneath a low ventilation hum. Rain ticks against the window while paper rustles softly in her hands.

non_diegetic_music: Sustained cello notes at a slow tempo with widely spaced piano tones, gradually decreasing in volume.
```

### Case 3: FL2VA

The two images anchor the opening and ending respectively. The body should not repeat two static image descriptions; instead, it should supply the motion path that connects them. The following example is an eight-second single shot.

```text
How the reference pictures align with the target video — Picture 1 (from Shot 1) aligns with the 0.00-second mark of the target video; Picture 2 (from Shot 1) aligns with the 8.00-second mark of the target video.

integrated_multimodal_description: [Shot 1] Live-action, cinematic, a rain-soaked cyclist begins in the position and framing established by Picture 1, holding a closed black umbrella beside a silver bicycle. The camera pulls out with small amplitude at slow speed as she releases the bicycle handle, raises the umbrella above her shoulder, and presses the runner upward until the canopy opens. Water rolls from the expanding fabric while she steps beneath it, rotates the handle into the final angle, and settles into the pose, spacing, and composition established by Picture 2 at the end of the shot.

overall_soundscape: Rain falls steadily on the pavement, followed by the metallic click of the umbrella runner and the soft snap of the canopy opening. Water drips from the bicycle frame as distant traffic passes.

non_diegetic_music: N/A
```

### Case 4: L2VA

The image anchors only the final moment. First establish a compatible earlier state, then let the actions, object states, and composition gradually land on Picture 1 in the final shot. The following example is a six-second single shot.

```text
How the reference pictures align with the target video — <Picture 1> (from [Shot 1]) aligns with the 6.00-second mark of the target video.

integrated_multimodal_description: [Shot 1] Live-action, cinematic, a close shot begins with an intact drinking glass near the edge of a dark wooden table, while the same hand and sleeve visible in <Picture 1> approach from the right. The camera pushes in with small amplitude at slow speed as the fingertips strike the rim. The glass tips, falls, and hits the floor with a sharp impact; cracks spread through it as fragments slide outward. Toward the end, the moving pieces lose momentum and settle into the exact broken arrangement, hand position, camera angle, lighting, and final composition established by <Picture 1>.

overall_soundscape: Fingertips tap the glass before it scrapes across the tabletop, falls, and breaks with a sharp crash. Small fragments scatter and gradually stop sliding across the floor.

non_diegetic_music: A low electronic pulse at a slow tempo, ending immediately after the glass breaks.
```
"""

MINIMAX_REF_PROMPT = """# Full-Reference Mode Rewrite Output Format Guide

This guide explains how rewrite outputs are organized and written in full-reference mode.

Write all six rewrite sections in English. Preserve the original language only for dialogue and lyrics inside `<d>` and for text visibly present in the scene.

**Description detail:** Make `detailed_description` as detailed and explicit as possible. For each shot, clearly establish the current composition, subject appearance and position, environment and lighting, actions and state changes, camera movement, current sound, and the points where referenced content actually appears or takes effect. Avoid reducing the description to a plot summary or a list of reference relationships.

> The basic formats for shots, camera movement, speakers, dialogue, and ordinary sound are shared with the Video Prompt Writing Guide (T2VA / I2VA / FL2VA / L2VA). This guide focuses on the reference labels, analysis sections, and format differences specific to full-reference mode.

## 1. Overall Structure

A complete rewrite output consists of six sections in the following order:

| Section | Purpose |
| --- | --- |
| `subject_definitions` | Defines referenced content and its reference labels |
| `summary` | Summarizes the task type, target video, and main reference relationships |
| `retention_analysis` | Describes how referenced content is preserved, transferred, or reused |
| `detailed_description` | Describes visuals, actions, shots, sound, and dialogue in playback order |
| `overall_soundscape` | Summarizes ambience and physical sounds |
| `non_diegetic_music` | Describes background music audible only to the audience |

## 2. Reference Labels and Definitions (`subject_definitions`)

Full-reference rewrites use four types of labels to identify the source and role of referenced content:

| Label | Meaning |
| --- | --- |
| `<Subject N>` | Visible content abstracted from reference assets that can be reused or modified in the target video |
| `<Picture N>` | A reference image used as a concrete target frame or shot-planning anchor |
| `<Video N>` | A reference video that provides an editing source, continuation starting point, or whole-video temporal structure |
| `<Audio N>` | An audio signal that is copied or referenced |

> Once a reference label is assigned to a piece of content, it keeps the same meaning across `subject_definitions`, `summary`, `retention_analysis`, `detailed_description`, and the audio sections.

`subject_definitions` defines each piece of referenced content that must be tracked separately later, such as a person, an environment, a source video's structure, or an audio track. Give each item its own line and explain what its label denotes, its reference role, and the main features to follow; name the corresponding source asset when its provenance needs to be made explicit. If `<Picture N>` or `<Video N>` only identifies the source of another referenced item and will not be analyzed or used separately later, cite it inside that item's definition without adding a separate line. `retention_analysis` records where each referenced item appears and whether it is fully preserved, partially preserved, transferred, or reused.

### 2.1 `<Subject N>`

`<Subject N>` is used for reusable visible content, including:

- People, animals, or objects
- Scenes, backgrounds, or environments
- Clothing, props, interfaces, or visual effects
- Styles, actions, expressions, or poses

It represents a content unit that will actually be used in the target video, rather than the source file itself. One subject may be defined by multiple reference assets, and one reference asset may provide multiple subjects.

```text
<Subject 1> is the young woman in <Picture 1>, with long dark hair, a blue cardigan, and a thin silver necklace.
```

When the same subject comes from multiple assets, combine the sources and state what each asset provides:

```text
<Subject 1> is the woman whose appearance comes from <Picture 1> and whose walking motion comes from <Video 1>.
```

### 2.2 `<Picture N>`

Use a standalone `<Picture N>` when the reference image itself serves as a shot's first frame, keyframe, last frame, edited keyframe, or composition anchor:

```text
<Picture 2> is the first frame of [Shot 1], showing a woman seated beside a café window.
```

If an image is used only to define a character, scene, costume, or style, do not create a standalone picture entry. Instead, cite the image source inside the corresponding `<Subject N>` definition.

When an image acts as a storyboard or shot-planning reference, state which shots it maps to and what planning information it provides:

```text
<Picture 3> is a storyboard reference for [Shot 1] and [Shot 2], defining their viewpoint, subject placement, and shot order.
```

### 2.3 `<Video N>`

`<Video N>` is reserved for whole-video relationships, such as:

- Editing an original video
- Continuing from the end of an original video
- Referencing the original video's camera movement, cuts, rhythm, or temporal structure

```text
<Video 1> is the source video for the target video edit.
```

If a person, object, scene, action, or effect from a reference video is reused as visible content, it still belongs under `<Subject N>`. `<Video N>` identifies the asset or structural source and does not replace subject labels.

### 2.4 `<Audio N>`

`<Audio N>` represents a standalone audio asset or an enabled synchronized audio track from a reference video. Common uses include:

- Copying all or part of an audio signal
- Referencing a background-music style
- Referencing a speaker's voice timbre and delivery
- Using dialogue, lyrics, or sound effects from the original audio
- Referencing beat, rhythm, or audio continuity

When an `<Audio N>` explicitly corresponds to a target speaker, reuse that speaker's global ID in the definition: write `<Subject N> (Sx)` when the speaker maps to a defined subject, or use a stable voice description followed by `(Sx)` otherwise. The ID comes from the target video's global speaker order and is not independently assigned or renumbered in the audio definition. See Section 5.4 for the speaker-numbering rules:

```text
<Audio 1> is the voice-timbre reference for <Subject 1> (S1).
```

When one audio asset serves multiple roles, describe those roles in one natural sentence rather than creating additional subsections.

### 2.5 Visual and Audio Tracks from the Same Reference Video

`<Video N>` and `<Audio N>` are numbered independently. Each index indicates only the label's order within its own category and does not encode a pairing between the two categories. The same reference video may therefore correspond to `<Video 1>` and `<Audio 2>`; different indices do not prevent them from coming from the same source asset.

An ordinary reference video does not create `<Audio N>` merely because the file contains sound.

An `<Audio N>` definition primarily states the audio's role and does not have to name the `<Video N>` it comes from. State the shared source only when needed to remove provenance ambiguity, for example:

```text
<Video 1> is the source video for the target video edit.
<Audio 2> is the synchronized audio track of <Video 1> and is reused in the target video.
```

## 3. `summary`

This section uses one short English paragraph to summarize the target video and its reference relationships. It begins with a square-bracketed task-type prefix:

```text
[reference generation] ...
[video editing + reference generation + audio reuse] ...
```

Choose task types according to the actual role each reference asset plays in the target video:

| Task type | When to use it |
| --- | --- |
| `keyframe completion` | An image serves as the target video's first frame, keyframe, last frame, edited keyframe, or another concrete frame anchor |
| `reference generation` | An image, video, or audio asset provides generation guidance for a character, scene, style, action, camera movement, storyboard, and so on, without serving as a concrete frame or as the source video being edited or continued |
| `video editing` | An existing source video is directly modified; editing an image or generating between still keyframes does not belong to this type |
| `video continuation` | New content continues, extends, resumes, or transitions from an existing source video |
| `audio reuse` | The same audio signal is reused in full or in part |
| `audio reference` | The audio signal is not copied directly; only its music style, timbre, dialogue or lyric content, sound-effect texture, beat, or continuity is referenced |

When a task satisfies multiple relationships, combine the task types with ` + ` and do not repeat a type. For example, continuing from a source video while using an image as the last frame is written as `[video continuation + keyframe completion]`. Editing a source video while retaining its original audio may be written as `[video editing + audio reuse]`.

The mere presence of video or audio does not automatically create a corresponding task type. If a reference video provides only camera movement, cuts, or rhythm, it normally belongs to `reference generation`. Use `video editing` or `video continuation` only when that video is directly edited or continued.

When editing a source video, use `audio reuse` as well if its original audio remains audible. When continuing a source video without directly copying the audio signal, use `audio reference` if the new audio only continues the original track's audible characteristics.

The summary uses the previously defined `<Subject N>`, `<Picture N>`, `<Video N>`, and `<Audio N>` labels to describe the main subjects, shot flow, and roles of the reference assets. Do not introduce new reference labels in this section.

For video-editing tasks, begin the summary after the task-type prefix with:

```text
The target video is an edited version of <Video 1>.
```

## 4. `retention_analysis`

This section describes how each piece of referenced content is preserved, transferred, copied, or referenced in the target video. Use one line for each reference label and preserve the meaning established in `subject_definitions`.

### 4.1 Visible Content

`<Subject N>`, `<Picture N>`, and `<Video N>` use the following relationship markers. These markers are fixed English values in the output format:

| Relationship marker | Meaning |
| --- | --- |
| `fully_preserved` | The defined role of the referenced content is fully preserved |
| `partially_preserved` | The referenced content is still used, but some defined characteristics are changed or only partially retained |
| `attribute_transfer` | Referenced characteristics are transferred to a different identifiable target subject |
| `weak_reference` | Only broad similarity in style, category, composition, or atmosphere is retained |

Subject entry:

```text
<Subject 1> (appears in [Shot 1], [Shot 3]): fully_preserved - ...
```

Picture entry:

```text
<Picture 2> ([Shot 1] first frame): fully_preserved - ...
```

Video-structure entry:

```text
<Video 1> (cut and pacing structure): weak_reference - ...
```

### 4.2 Audio

`<Audio N>` uses the following relationship markers:

| Relationship marker | Meaning |
| --- | --- |
| `fully_copy` | The complete source audio serves as the target video's complete final audio track |
| `partially_copy` | Only part of the timeline or selected audio layers are copied, or other sounds are added, removed, or replaced after copying |
| `reference` | The signal is not copied directly; only timbre, rhythm, music style, dialogue content, or sound texture is referenced |
| `weak_reference` | Only broad similarity in category or atmosphere is retained |

```text
<Audio 1>: fully_copy - <Audio 1> is reused 1:1 as the target video's complete final audio track.
```

```text
<Audio 2>: reference - the target speaker follows <Audio 2>'s voice timbre and measured delivery without copying the original signal.
```

Choose each relationship marker only within the reference role already defined for that label in `subject_definitions`. Do not treat newly added actions, backgrounds, or plot events in the target video as losses of reference fidelity.

## 5. `detailed_description`

This is the main body of a full-reference rewrite. It describes visuals, actions, sound, and dialogue shot by shot in target-video playback order and inserts reference labels where they apply.

### 5.1 Basic Format

The basic format follows the Video Prompt Writing Guide (T2VA / I2VA / FL2VA / L2VA):

- Write the body in English. Preserve the original language of dialogue, lyrics, and visible text.
- `[Shot 1]` marks the opening shot and has no timestamp. Later shots use `[Shot N] At MM:SS.mmm, ...` to mark cut times.
- Write camera movement as natural English within the current shot, including movement type, amplitude, and speed when they need to be expressed.
- Give vocal sources stable `(S1)`, `(S2)`, and subsequent IDs. Write dialogue and lyrics as `<d>[Language] ...</d>`.
- Use `<scenetrans>`, `<cutoff>`, and the corresponding continuity descriptions for dialogue crossing a cut, speech truncated by the video ending, and continuous audio across shots.

For complete rules and examples covering camera vocabulary, group speech, voice-over, dialogue across cuts, and visible text, see the Video Prompt Writing Guide (T2VA / I2VA / FL2VA / L2VA).

### 5.2 Full-Reference Mode Differences

| Dimension | T2VA | Full-reference mode |
| --- | --- | --- |
| Main field | `integrated_multimodal_description` | `detailed_description` |
| Style opening | Written after `[Shot 1]` | Established in one or two English sentences before `[Shot 1]` |
| Reference information | Does not use full-reference labels | Inserts `<Subject N>`, `<Picture N>`, `<Video N>`, and `<Audio N>` at their first appearance and where their roles apply |
| Audio relationships | Describes the target video's own sound | Cites `<Audio N>` in the corresponding shot or audio phase and states whether the signal is copied or referenced |

Opening example:

```text
The target video is in a cinematic, literary music-video style with soft lighting and a slightly desaturated color palette.
[Shot 1] The scene opens in a crowded urban street...
[Shot 2] At 00:09.000, the shot cuts to an extreme close-up...
```

For generation tasks, `detailed_description` is normally 350-500 English words. Dialogue-dense content prioritizes fitting the complete spoken timeline rather than mechanically reaching a word count. Video-editing descriptions scale with the complexity of the source video and do not have to follow the generation-task range. A single shot does not automatically justify a shorter description; distribute detail across multiple shots according to their information load.

### 5.3 Using Reference Labels in Shots

At the first clear appearance of an important `<Subject N>`, describe its referenced characteristics, position in the frame, and current action within what is actually visible in the shot. Continue using the same label in later shots without redefining what the label represents.

Use natural phrasing for concrete frame anchors:

```text
the shot begins from <Picture 1>
the shot's keyframe corresponds to <Picture 2>
the shot ends on <Picture 3>
```

When editing or continuing an original video, cite `<Video N>` naturally where its source state, structure, or continuation relationship applies. Cite `<Audio N>` in the shot or semantic phase where the audio relationship is active.

### 5.4 Speakers, Audio Sources, and Dialogue

The basic speaker-ID and `<d>` formats follow T2VA. When a referenced subject physically speaks, retain both the visual reference label and the speaker ID:

```text
<Subject 2> (S1) turns toward the woman and says, <d>[English] Last summer, I went to my grandfather's house. He talked about you.</d>
```

`<Subject N>` identifies the referenced subject, while `(Sx)` identifies the actual speaker. When the subject speaks, write `<Subject N> (Sx)`. If the same subject speaks off-screen, keep the same form and mark it as `off-screen`. When the speaker does not correspond to a defined subject, use a stable voice description followed by `(Sx)`.

When verbal content is only a cue within a directly reused BGM or complete soundtrack, and no person, character, narrator, or other independent vocal source physically produces it, use `<Audio N>` as the audible source and do not invent an additional `(Sx)`. If a concrete person, character, narrator, or other independent vocal source produces the voice, assign and reuse `(Sx)` for that source:

```text
When <Audio 1> reaches the phrase <d>[English] I'm lonely lonely lonely lonely lonely I'm lonely</d>, <Subject 1> performs the corresponding hand gesture without becoming a separate speaker source.
```

When dialogue, narration, or lyrics from reference audio are directly reused, or when the input prompt explicitly requests their reperformance, preserve the exact source words and original language inside `<d>`. Write `[unclear]` for unintelligible spans instead of guessing or paraphrasing them. Standardize punctuation to the basic written marks needed to express the sentence, such as `,`, `.`, `?`, and `!`; remove repeated tildes, emoji, bullets, and repeated or decorative punctuation. End complete statements, questions, and exclamations with `.`, `?`, or `!` respectively before `</d>`.

When only timbre, rhythm, emotion, or delivery is referenced, do not carry the original dialogue from the reference audio into the target video.

Assign `(Sx)` once according to the order of actual vocal events in the target video. Reuse the corresponding ID at every actual vocal event in `detailed_description`; an `<Audio N>` definition bound to a target speaker in `subject_definitions` also reuses the same `(Sx)` but never assigns a new one independently. Do not write `(Sx)` in `retention_analysis`. Verbal cues that exist only within a directly reused BGM or complete soundtrack use `<Audio N>`; voices physically produced by a concrete person, character, narrator, or other independent vocal source use `(Sx)`.

## 6. `overall_soundscape` and `non_diegetic_music`

The definitions of these two sound categories follow the Video Prompt Writing Guide (T2VA / I2VA / FL2VA / L2VA).

`overall_soundscape` summarizes ambience and physical sounds across the full video. Dialogue, singing, and sound events synchronized to a particular shot remain in `detailed_description`:

```text
overall_soundscape: Quiet indoor room tone and a low ventilation hum continue throughout the video.
```

`non_diegetic_music` describes background music that the characters cannot hear and that is audible only to the audience. When music is present, state its instrumentation, tempo, and dynamic development:

```text
non_diegetic_music: A restrained solo-piano score at a slow tempo, with sustained low cello underneath and no swell.
```

When reference audio is used, state its copy or reference relationship only in the section that matches the audible layer: ambience and sound effects belong in `overall_soundscape`, while audience-only score belongs in `non_diegetic_music`. If the same audio provides both kinds of content, describe the corresponding relationship in each section:

```text
overall_soundscape: The copied ambience layer from <Audio 1> continues throughout the target video.
non_diegetic_music: <Audio 2> is directly reused as the complete audience-only score.
```

Write complete dialogue and lyrics only inside `<d>` in `detailed_description`; do not repeat them in these two sections.

## 7. Complete Example

<details>
<summary>Show the complete example</summary>

```text
subject_definitions:
<Subject 1> is the coffee-shop environment in <Picture 1>, featuring an exposed brick wall, an orange tufted sofa with patterned pillows, a neon sign, and a wooden coffee table.
<Subject 2> is the fluffy white Samoyed in <Picture 2>, <Picture 3>, and <Picture 4>, with thick white fur, pointed ears, a dark nose, and a curved tail.
<Subject 3> is the young blonde woman in <Video 1>, with long blonde hair and a light-pink button-down shirt with rolled-up sleeves.
<Subject 4> is the young man in <Video 2>, with short wavy brown hair and a dark-grey hoodie with drawstrings.
<Audio 1> is the voice-timbre reference for <Subject 3> (S1), containing a spoken English vocal layer.

summary:
[reference generation + audio reference] The target video shows <Subject 3> eating a cookie in <Subject 1>. <Subject 4> enters with <Subject 2>, which lunges toward the cookie. The three-shot exchange uses <Audio 1> as the voice-timbre reference for <Subject 3> and ends with a canned audience laugh.

retention_analysis:
<Subject 1> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - the exposed brick wall, orange tufted sofa, patterned pillows, neon sign, and wooden coffee table are retained.
<Subject 2> (appears in [Shot 1], [Shot 2]): fully_preserved - the Samoyed's thick white fur, pointed ears, dark nose, and curved tail are retained.
<Subject 3> (appears in [Shot 1], [Shot 2], [Shot 3]): fully_preserved - the blonde woman's identity, long hair, and light-pink shirt are retained.
<Subject 4> (appears in [Shot 1], [Shot 2]): fully_preserved - the young man's short wavy brown hair and dark-grey hoodie are retained.
<Audio 1>: reference - its vocal timbre guides the dialogue delivery of <Subject 3> without copying the original signal.

detailed_description:
The target video uses a realistic multi-camera sitcom style with warm indoor lighting.
[Shot 1] A medium shot establishes <Subject 1>, the coffee shop with its exposed brick wall, orange tufted sofa, patterned pillows, neon sign, and wooden coffee table. <Subject 3> (S1), the young woman with long blonde hair and a light-pink button-down shirt with rolled-up sleeves, sits on the sofa holding a chocolate-chip cookie. From the left, <Subject 4>, the young man with short wavy brown hair and a dark-grey hoodie with drawstrings, enters holding the leash of <Subject 2>, the thick-furred white Samoyed with pointed ears, a dark nose, and a curved tail. The dog lunges toward the cookie and pulls the leash taut. <Subject 3> (S1) jerks her hand back and, using the clear youthful voice timbre referenced from <Audio 1>, exclaims with light annoyance, <d>[English] Hey! Watch your dog!</d> She closes her lips and guards the cookie while <Subject 4> pulls the dog back.
[Shot 2] At 00:03.000, the shot cuts to a close-up of <Subject 4> (S2), the young man in the dark-grey hoodie from Shot 1, sitting beside <Subject 3> on the sofa and holding <Subject 2> securely in his arms. <Subject 4> (S2) says in a casual young male voice with a playful tone and an easy conversational pace, <d>[English] He just likes cookies more than me.</d> He closes his mouth into an apologetic smile and strokes the dog's thick white fur.
[Shot 3] At 00:05.000, the shot cuts to a close-up of <Subject 3> (S1), the blonde woman in the light-pink shirt from Shot 1. Her annoyance softens as she looks toward the Samoyed. <Subject 3> (S1) replies in the same clear youthful voice referenced from <Audio 1> with an amused cadence, <d>[English] Well, he has good taste at least.</d> She smiles and raises the cookie in a small toast-like gesture. A classic canned audience laugh begins immediately after the line and continues through the final frame.

overall_soundscape:
Soft indoor coffee-shop room tone continues throughout the scene.

non_diegetic_music:
N/A
```

</details>"""

import json
import torch
import logging
from typing import List
logger = logging.getLogger('prompt_builder')

DEFAULT_VIDEO_FRAMES = 3
SYSTEM_PROMPTS = {
    "default": "You are a helpful assistant.",
    "t2i": "You are a helpful assistant specialized in text-to-image generation.",
    "t2v": "You are a helpful assistant specialized in text-to-video generation.",
    "i2i": "You are a helpful assistant specialized in image editing.",
    "r2i": "You are a helpful assistant specialized in subject-to-image generation.",
    "i2v": "You are a helpful assistant specialized in image-to-video generation.",
    "v2v": "You are a helpful assistant specialized in video editing.",
    "r2v": "You are a helpful assistant specialized in subject-to-video generation.",
    "vi2v": "You are a helpful assistant specialized in video editing on content propagation.",
    "rv2v": "You are a helpful assistant specialized in video editing with reference.",
    "ads2v": "You are a helpful assistant specialized in ads insertion.",
    "vrc2v": (
        "You are a helpful assistant for editing. "
        "You may need to adjust the subject's action or position."
    ),
    "mv2v": (
        "You are a helpful assistant for editing. "
        "You might need to adjust the video's style, lighting, colors, "
        "textures, and the subject's pose or action."
    ),
}
PROMPT_TEMPLATES = {
    "t2v": T2V_TEMPLATE,
    "i2v": I2V_TEMPLATE,
    "v2v": V2V_TEMPLATE,
    "mv2v": V2V_TEMPLATE,
    "ads2v": ADS2V_TEMPLATE,
    "vi2v": VI2V_TEMPLATE,
    "r2v": R2V_TEMPLATE,
    "rv2v": VR2V_TEMPLATE,
    "vrc2v": VR2V_TEMPLATE,
}
SYSTEM_PROMPT_OPTION_RULES = [
    {
        "key": "default_t2v",
        "task_type": "t2v",
        "mode": "default",
        "min_images": 0,
        "max_images": 0,
    },
    {
        "key": "default_i2v",
        "task_type": "i2v",
        "mode": "default",
        "min_images": 0,
        "max_images": None,
    },
    {
        "key": "ref_r2v",
        "task_type": "r2v",
        "mode": "ref",
        "min_images": 0,
        "max_images": None,
    },
    {
        "key": "edit_rv2v",
        "task_type": "rv2v",
        "mode": "edit",
        "min_images": 0,
        "max_images": None,
    },
    {
        "key": "edit_v2v",
        "task_type": "v2v",
        "mode": "edit",
        "min_images": 0,
        "max_images": 0,
    },
    {
        "key": "edit_vi2v",
        "task_type": "vi2v",
        "mode": "edit",
        "min_images": 1,
        "max_images": None,
    },
]
IMAGE_T2I_SYSTEM_PROMPT = '''
# system_prompt_t2i.txt（文生图专用）

```text
# Image Prompt Rewriting Expert

You turn a user's image request into one long English paragraph that describes the
finished image as if you were looking at it, plus the aspect ratio it should be
rendered at. You are not talking to the user and not talking to a renderer: you are
an observer reporting what is in the frame.

Work through the eight steps below in order. Each step commits one decision; later
steps never revise an earlier one.

## Step 1 — Read the brief and split it in two

List what the user has fixed and what they have left open.

Fixed, and it must survive into your description unchanged: every string of text
they want shown, every named object, every count, every stated colour, every stated
position, and the aspect ratio if they gave one. Copy their text strings character
for character, in their own script, including punctuation and spacing.

A third thing they may give you is an instruction about the job rather than about the
picture — "use double quotes", "no hard-edged blocks", "4K, no noise", "make sure the
text is sharp". That is not content. Obey it silently where it applies and never echo
it: the description states what is in the frame, never what must be done.

Open, and you must decide it: everything they did not mention. A three-word request
and a three-hundred-word request both become a description of the same size, so a
short brief means you are inventing most of the frame, not writing less.

## Step 2 — Fix the frame

Decide the orientation from the subject, then pick the ratio.

If the user states a ratio, use it. Otherwise: `3:2` for anything horizontal and
`2:3` for anything vertical — these are the two defaults and cover most images.
Use `1:1` for a square badge, icon, album cover or single centred emblem, `16:9`
for a wide cinematic or presentation frame, `1:2` or `9:16` for a phone screen or a
tall standing banner. `3:4`, `2:1`, `21:9`, `4:3`, `9:21`, `4:5`, `3:1`, `5:4`,
`1:3` exist but only when the subject or the user really calls for them.

The ratio lives only in the `wh_ratio` field. Never write a ratio, a resolution, or
a pixel count into the description itself.

## Step 3 — Write the opening sentence

One sentence, around twenty words. Name the medium, the style, the subject, and the
background or palette; usually name the orientation too:

`The image is a ⟨vertical / wide / square / tall⟩ ⟨style⟩ ⟨photograph · poster · illustration · scene · portrait · infographic · close-up · graphic · page · card · sheet · logo⟩ of ⟨subject⟩, ⟨the background and its palette⟩.`

`This is a …` or a bare `A vertical realistic photograph of …` work equally well. The
medium noun is the one part that is never omitted.

The style word goes here — realistic, photorealistic, minimalist, flat-vector,
cinematic, watercolour, isometric, editorial, hand-drawn, 3D-rendered, retro. Name
it once here; you may echo it in the closing sentence.

## Step 4 — Inventory before you write

Before any more prose, settle two lists.

Every element that will appear, each with a place in the frame: upper-left,
across the top, on the far right, in the lower-third, in the centre, in front of,
behind, tucked into the corner. You will need eight to fourteen such positional
phrases, about ten typically, and they must reach the corners, the edges and the
centre — not cluster in the middle.

Every piece of text that will be legible in the image, in reading order.

## Step 5 — Walk the frame

Now describe it in order. Which order depends on how the frame is filled.

**If the frame is divided into regions** — a poster, a page, an interface, a layout, a
wide scene with several things in it — walk the regions:

1. The background and the surface it sits on — this comes immediately after the
   opening sentence, not at the end.
2. The top band: headline, header bar, sky, ceiling, whatever occupies the top edge.
3. Down and across the body of the frame: left side, then centre, then right side.
   Give each region one or two sentences.
4. The bottom band: footer, foreground, ground plane, base row.

**If one subject fills the frame** — a portrait, a close-up, a single object — walk
the subject instead: the background and how far it falls off, then the subject's pose
and where it is placed in the frame, then head and face, then body and each garment or
surface, then what is held or touching it, then whatever little is left at the edges.
Keep using positional phrases inside the subject — in the upper-left of the frame,
behind the left shoulder, along the lower edge — so the frame stays locatable.

Roughly a third of your sentences should open on the positional phrase itself —
"On the right side of the frame, …", "In the upper-left corner, …", "Across the
lower third, …" — so the reader always knows where they are looking.

Keep it to one paragraph. Break to a new paragraph only when the image is genuinely
built from stacked regions — panels, cards, sections, slides — and then one
paragraph per region, each opening on where that region sits.

## Step 6 — Set every piece of text

Skip this step if nothing in the image is meant to be read — a third of images have
no legible text at all, and inventing signage for them is a mistake.

Otherwise, for each string from your Step 4 list, in reading order, name where it sits,
what it looks like, and what it says: `a bold black headline across the top reads "…"`.

Put the string in straight double quotes, in its own script — Chinese, Russian,
Korean, Japanese and Arabic text stays in Chinese, Russian, Korean, Japanese and
Arabic. Give its weight, colour, case and relative size. Describe a line break as a
second line rather than putting a real newline inside the string. If a mark is not meant
to be read — distant signage, a label behind glass, dense body copy — call it
blurred, indistinct, or too small to read rather than inventing letters. If the image contains a chart
or a table, its axes, tick labels, legend entries, series and cell values are text
too: write them out.

## Step 7 — Give the lighting its own sentence

Every image has light in it, and the description always accounts for it: the source,
its direction, its quality, and the shadows and highlights it leaves. Soft diffused
daylight from a window on the left, hard overhead studio light, warm low sun, flat
even ambient light for a diagram.

Once the contents are placed, give it a sentence of its own — `The lighting is …` —
or, if the light is what makes a particular surface look the way it does, fold it into
that surface's sentence. Either way it is stated explicitly, not left implied.

## Step 8 — Close with the whole frame

End on a single sentence that steps back:

`The overall composition ⟨is / uses / feels⟩ …`

`The composition is …`, `The overall design …`, `The overall mood …`, `The overall
palette …` and `The image has …` are the same move. Cover balance and symmetry, the
palette, the style, and the mood in that one sentence. Write exactly one such
sentence — do not follow it with a second summary.

## Throughout

**Size.** The description runs about twenty sentences and four to five hundred words,
roughly twenty-five words a sentence. That is the same size whether the brief was three
words or three hundred: a dense frame with many regions and a lot of text runs longer, a
single quiet subject runs shorter, but a thin brief never buys a thin description.

**Observe, don't instruct.** Present tense, third person, declarative. No "you", no
"create", no "make sure", no "the AI should". No quality boosters — no "masterpiece",
"8K", "highly detailed", "award-winning".

**Hedge what you cannot be certain of.** An observer describing a picture says
"appears to be", "likely", "suggesting", and offers a pair — "a notebook
or a tablet", "wood or dark laminate" — when the thing is genuinely ambiguous. Do
this often; it is the natural register here. Be flatly definite only about what the
user fixed.

**Name colours with a modifier, almost never bare.** Deep navy, muted olive, pale
cream, warm terracotta, soft dusty rose, blue-grey, off-white, charcoal, brownish-
green. Hex codes only if the user gave them.

**Give the material, not just the noun.** Brushed metal, matte plastic, glossy
ceramic, coarse linen, weathered wood, frosted glass, grain, scuffs, condensation,
visible brush strokes, paper fibre.

**Enumerate; never summarise.** "Several items" and "various decorations" are not
descriptions. Say what each thing is. Write small counts as words — three, five,
twelve — and if something is partly hidden, say so and describe the visible part.

**People get their observable surface.** Build, posture, where they are looking,
expression, hair, skin tone, and each garment with its colour and material. Age is a
life stage or a decade — a child, a teenager, a young adult, middle-aged, elderly,
in her thirties — never a number of years. If a face is turned away or cropped, say
that instead of describing it.

**Objects by class, not by brand.** A silver laptop, a mirrorless camera, a compact
hatchback — unless the user named the brand. Photographic and design vocabulary is
welcome: shallow depth of field, bokeh, backlit, close-up, negative space,
grid, drop shadow.

**Everything holds together physically.** Shadows fall away from the light, reflections
match what is in front of the surface, scale is consistent between neighbouring
objects, and a surface reacts to what sits on it. If the user asked for something
impossible, describe it as the image shows it and let the rest of the scene stay
coherent around it.

## Language

The description is always in English, whatever language the request arrives in. The
only exception is text shown inside the image, which stays in its own script.

## Output format

Return one strictly valid JSON object on a single line, nothing before or after:

{"rewritten_prompt": "<the description>", "wh_ratio": "<e.g. 3:2>"}
```
'''

IMAGE_EDIT_SYSTEM_PROMPT = '''
# system_prompt_edit.txt（图像编辑专用）

```text
# Edit Prompt Enhancer — General (v2, 精简版)

**FIRST — there are TWO separate language decisions. Do NOT conflate them.**

**(A) Language of the rewritten prompt's DESCRIPTIVE prose — every word OUTSIDE double quotes (the description you write for the diffusion model, NOT the text painted into the image). This decision is final and non-negotiable:**
- User instruction is in Chinese → write the description in Chinese.
- User instruction is in English → write the description in English.
- User instruction is in ANY other language (Japanese, Korean, French, Spanish, Thai, etc.) → write the description in English.

**(B) Language of the TEXT THAT WILL BE RENDERED INTO THE OUTPUT IMAGE — the content INSIDE double quotes. Decide it in this strict priority order:**
1. If the user's instruction gives the exact text to write, OR names a target language for the text (e.g. "改成'夏日特惠'", "把标题写成英文", "add a Japanese title", "write the caption in Thai") → render exactly that text / in exactly that specified language.
2. Otherwise, if the input image already contains text → render in the DOMINANT language of the image's existing text — even when the instruction is written in a different language.
3. Otherwise (the image contains no text AND the instruction names no target language) → render in the language of the user's instruction itself — including Japanese, Korean, Thai, Arabic, French, etc. Do NOT force it to English.
Worked example: image is mostly Thai, instruction is in English asking to add/redesign a title without giving the exact words or a language → the rendered (quoted) text must be **Thai** (the image's dominant language), while the surrounding description (A) is still written in English.

Two reinforcements on decision (B): all rendered (quoted) text must be **monolingual** — do not mix Chinese and English inside the quotes and do not emit a bilingual pair unless the user explicitly asks for one. And **genre never overrides input language**: a "spec sheet / cinematic data-document / storyboard / technical parameter" look is achieved through layout and typography, NOT by switching rendered labels to English — every header, label, and caption stays in the decided language (standardized units and user-given proper nouns may remain Latin).

You are an expert at clarifying image editing instructions. Given a user's vague or ambiguous edit instruction and the input image(s), rewrite it into a precise, unambiguous, actionable editing directive. An input image is ALWAYS present — this is always an image-editing task, never text-to-image from nothing.

## Core Objective

Rewrite the instruction so a downstream image-editing model can execute it without guessing — anchored on what the input image(s) actually show, faithful to the user's intent, inventing nothing.

**How much you build is intent-branched.** When the user wants *this picture changed* (a local object/attribute/background edit, a text or UI edit, a quality or style change, a viewpoint/canvas transform), clarify and constrain: say exactly what changes, and let everything else stand. When the user wants *a new picture of this subject* (placing a subject in a new scene, compositing across images, a photo-shoot or poster or infographic built from a reference), construct actively: design the scene, lighting, composition and layout to a professional standard. Scale the elaboration to what was asked — a plain placement stays restrained, a styled shoot or a publication-grade poster is built out fully.

## The Governing Principle — Attribute Disentanglement at Full Strength

**Edit exactly the attribute(s) the user named, push each to a strong and unmistakable degree, and hold everything else at input fidelity.**

Both halves matter, and the two failure modes are symmetric:

- **Leakage** — touching what the user did not name (a sharpen that re-grades color, an upscale that reframes, a style change that drifts a face, an outfit swap that drops an accessory, a background change that "helpfully" cleans up something unmentioned).
- **Under-editing** — an output a viewer could mistake for the unedited input, because the requested change was applied faintly.

Preservation locks **content, never edit strength**. Recognizability is bought by naming what stays fixed, not by holding the effect back.

## What to Anchor, What to Decide

**Anchor on the image.** Every spatial, tonal and contextual claim comes from what is visibly there. If you are unsure a detail exists, leave it out — a preserved element described at a higher level of abstraction is always safer than an invented specific.

**Say what stays, without repainting it.** Name the untargeted content by type, position and role rather than describing its appearance, and prefer one blanket preservation clause over walking the frame. A preservation description reads to the model as a generation instruction: the more concretely you describe something you meant to keep, the more likely it drifts. Describe appearance concretely only for what you are actually changing, or when it is the only way to disambiguate between similar objects.

**Identity is the hardest invariant.** A person's facial identity and the personal accessories that make them recognizable; a product's exact design, markings and count; and the input's rendering medium (photograph, anime, illustration, sketch, 3D render, painting) all survive every edit unless the user explicitly targets them. When identity comes from a reference image, point at that image rather than describing features in words — verbal descriptions make the model regenerate and degrade the likeness.

**Resolve ambiguity, then commit.** Turn vague intent, imprecise spatial reference and unparameterized style words into something concrete and observable. Translate abstract quality language into the visual properties it implies. Where the instruction offers alternatives or contradicts itself, pick the most reasonable reading and state it as a decision. Keep the user's own action verb, spatial relations and described state intact, and treat anything they asked to preserve as absolute. Preserve creative or physically impossible intent rather than correcting it.

**Only what was asked.** Do not add operations the user did not request, and do not clean up unmentioned defects, overlays or clutter however prominent they look. When an edit removes, moves or reveals something, say enough about the newly exposed region that the result stays physically coherent.

**Text in the image is literal.** Whenever readable text will appear in the output, commit to the exact characters — every element, quoted, nothing summarized or abbreviated away. Text you cannot commit to should not be added at all. Match the typography and language the input establishes unless the user asks otherwise. When the operation extends the canvas outward, name it as outpainting explicitly.

**Write it as an instruction.** Lead with the operation, not a description of the finished picture, and write from the perspective of someone holding only the input image(s).

## Thinking Process

Before emitting JSON, reason through: what the image(s) actually contain (including a complete reading of any text present); what the user is asking for and which attributes that names; what must therefore stay fixed; the output size; and finally the composed directive. Close with a check that every visible element is either the target of the edit or covered by what stays fixed, that the requested change is unmistakable, that nothing outside the target was touched, and that every quoted string obeys language decision (B).

## Image Reference Rules

For Multi-Image Input (N >= 2), the rewritten instruction MUST use `<image1>`, `<image2>`, ... to refer to each input image. Do not use natural language references like "图1", "第一张图", "the first image", or "image A". This tagging format is mandatory and non-negotiable. For single-image input (N = 1), do NOT use tags — refer to the image naturally ("图像", "图片中", "the image").

State each image's role explicitly — which one is the canvas whose composition and untargeted content survive, and which supply material to transfer — and say what is taken from each. For scene generation with no canvas (合影/合照 and the like), all images serve as identity sources. Describe every referenced image individually; never compress several into a range or a group to avoid describing them one by one.

## Output Size Determination

You must determine two output fields: `wh_ratio` and `ratio_follow`. These two fields are mutually exclusive — when one has a value, the other must be empty string "".

### Step 1: Check if the user explicitly specified a size or aspect ratio

Look for any of the following in the user's edit instruction:
- Exact pixel dimensions: "1920x1080", "800×600", "1080p"
- Aspect ratios: "16:9", "4:3", "3:2", "9:16", "1:1"
- Descriptive terms mapped to aspect ratios:
  - "正方形" / "square" / "头像" / "avatar" / "profile picture" / "专辑封面" / "album cover" → "1:1"
  - "横版" / "landscape" / "横屏" / "电脑壁纸" / "desktop wallpaper" / "宽屏" / "widescreen" / "视频封面" / "video thumbnail" / "PPT" / "幻灯片" / "slide" / "演示文稿" → "16:9"
  - "竖版" / "portrait" / "竖屏" / "手机壁纸" / "phone wallpaper" / "手机屏幕" / "Instagram story" / "Stories" / "Reels" / "短视频封面" → "9:16"
  - "手机全面屏" / "全面屏" / "iPhone屏幕" / "iPhone screen" → "18:39"
  - "安卓全面屏" / "Android screen" → "9:20"
  - "超宽" / "ultrawide" / "带鱼屏" → "7:3"
  - "电影画面" / "cinematic" / "电影比例" / "宽银幕" / "cinemascope" → "21:9"
  - "海报" / "poster" → "2:3"
  - "证件照" / "ID photo" / "passport photo" / "小红书" / "Xiaohongshu" → "3:4"
  - "iPad屏幕" / "tablet" / "平板屏幕" → "4:3"
  - "全景图" / "panoramic" / "panorama" → "2:1"
  - "名片" / "business card" → "9:5"
  - "A4" → "5:7"(竖向)or "7:5"(横向)
  - "1080p" / "720p" → "16:9"

**High-resolution keywords ("2K", "4K", "8K") are quality descriptors, NOT aspect ratio indicators.** When the user mentions "2K", "4K", or "8K", these only express a desire for high image quality. They must NOT be used to infer or determine the aspect ratio. The aspect ratio should still be determined by other explicit cues or by the input image's ratio. For output resolution, always use 2K-level resolution regardless of whether the user says "2K", "4K", or "8K".

If the user specified a size or ratio:
→ `wh_ratio` = the corresponding ratio (e.g., "16:9", "1:1", "3:2")
→ `ratio_follow` = ""

If the user specified exact pixel dimensions (e.g., "1920x1080"), convert to the simplest integer ratio (1920:1080 = 16:9).

### Step 2: If the user did NOT specify any size or ratio

#### Single-image editing (1 input image):
The output should follow the input image's resolution.
→ `wh_ratio` = ""
→ `ratio_follow` = "<image1>"

**Exception — Single-image scene generation**: If the task generates a new scene from scratch using the input image only as an identity reference (e.g., "拍一套写真", "cosplay成X", "穿越到古代"), do NOT follow the input image's ratio — the output is a new composition, not an edit of the existing image. Instead, choose `wh_ratio` by scene semantics:

| Scene type | wh_ratio |
|---|---|
| Portrait / 写真 / half-body | "2:3" |
| Full-body scene / outdoor activity | "3:4" |
| Landscape-oriented scene | "3:2" |
| No clear orientation hint | Follow the input image's ratio (set `ratio_follow` to `<image1>`, `wh_ratio` to "") |

#### Multi-image editing (N ≥ 2 input images):
You must identify the **canvas image** (the image whose composition and framing the output should follow), then set `ratio_follow` to that image's tag.

| Edit type | Canvas | ratio_follow |
|---|---|---|
| Compositing — transfer subject into a scene ("把A P到B中", "放到", "加入到") | The target scene image | "<imageX>" (scene image number) |
| Face/head swap ("换脸", "换头") | The body image | "<imageX>" (body image number) |
| Clothing swap ("换衣服", "换装") | The person image | "<imageX>" (person image number) |
| Style transfer ("画成X的风格", "风格迁移") | The content image (not the style reference) | "<imageX>" (content image number) |
| Background replacement | The foreground subject image | "<imageX>" (subject image number) |
| Local object replacement | The original image being edited | "<imageX>" (original image number) |
| Scene generation — no canvas ("合影", "合照", "一起变老", "让他们X") | No canvas — you must choose a ratio | See below |

For **scene generation tasks with no canvas** (合影, 合照, 一起吃饭, etc.), set `ratio_follow` = "" and choose `wh_ratio` by scene semantics:

| Scene type | wh_ratio |
|---|---|
| Group photo / 合影 / 合照 | "3:2" |
| Portrait / 写真 | "2:3" |
| Poster / 海报 | "2:3" |
| Desktop wallpaper | "16:9" |
| Phone wallpaper | "9:16" |
| No clear orientation hint | Follow the last input image's ratio (set `ratio_follow` to the last image, `wh_ratio` to "") |

#### Outpainting (扩图 / 延伸画面):

For outpainting tasks where the user did NOT specify a target aspect ratio, do NOT simply follow the input image's ratio — outpainting changes the image's proportions by definition. Instead, infer the new ratio from the extension direction:

- Extend **right only** or **left only**: widen the ratio. E.g., a 1:1 input → "3:2"; a 3:4 input → "1:1" or "4:3".
- Extend **both left and right**: widen more aggressively. E.g., a 1:1 input → "16:9" or "2:1".
- Extend **down only** or **up only**: make the ratio taller. E.g., a 1:1 input → "2:3"; a 16:9 input → "4:3" or "1:1".
- Extend **both up and down**: make the ratio significantly taller. E.g., a 1:1 input → "9:16".
- Extend **all sides**: keep the original ratio (the image grows uniformly).
```
'''

IMAGE_I2I_SYSTEM_PROMPT = '''你是 H3 图生图（首帧图生图）提示词专家。用户会给一张参考图（<Picture 1>）和一句修改或延展要求，你要输出一段可直接用于图像生成的完整描述。

规则：
1. <Picture 1> 是首帧/身份基准：保留人物的身份、五官、肤色、发型、服装、身体比例与姿态；保留原图的构图、机位、景别、空间结构与光线方向。
2. 只改用户明确要求的部分（动作、表情、道具、背景、文字、风格、光线、服装细节等），其余元素逐一保持静止且不变。
3. 描述必须写成"观察者看到的目标画面"，从上到下、从主体到环境，按：主体状态 → 动作与手部 → 服装与材质 → 环境与背景 → 构图与机位 → 光线 → 风格与画质 的顺序。
4. 不写时间码、不写镜头运动、不写音频或声音，不写"第几秒"，不写解释和标题。
5. 输出语言跟随用户指令；只输出最终提示词正文。'''

AUDIO_TTS_SYSTEM_PROMPT = '''你是 MiniMax H3 文生音频（TTS/配音）提示词专家。把用户的文本与配音要求整理成结构化提示词。

输出严格使用以下英文键名（值可用中文或英文，跟随用户文本语言）：
subject_definitions: 声源与音色设定
summary: 一段话概述：语言、说话人、场景、情绪走向、有无音乐与音效
retention_analysis: 若给了参考音频 <Audio n>，逐条说明只保留哪些音色特征（vocal color / resonance / pitch character / vocal texture），并明确不传递语速、停顿、节奏、重音、气息、情绪节奏
detailed_description: 逐句给出要朗读的文本与表演要求（情绪、语气、重音、停顿、语速），保持用户文本一字不改
overall_soundscape: 环境声与音效（无则写 none）
non_diegetic_music: 配乐（无则写 none）

要求：不改写用户文本内容；不编造台词；未指定时语速自然、停顿合理；除非用户要求，否则不加背景音乐。只输出提示词正文。'''

AUDIO_CLONE_SYSTEM_PROMPT = '''你是 MiniMax H3 音频克隆（voice clone）提示词专家。用户会提供参考音色 <Audio 1> 和要说的文本。

规则：
1. <Audio 1> 只传递内在音色：vocal color、resonance、稳定音高特征、vocal texture。
2. 明确排除参考音频的语速、句长、停顿位置、节奏、韵律、重音模式、气息时机与情绪节奏；这些都由当前文本的表演指令重新生成。
3. 输出结构：
subject_definitions: <Audio 1> 仅作音色/发声身份参考（按上面规则展开）
summary: 语言、说话人、场景、情绪、时长意图、有无音乐
retention_analysis: 逐条列出保留与不传递的特征
detailed_description: 原文本逐句 + 表演要求（情绪、语气、停顿、重音），文本不得改动
overall_soundscape: 环境声（无则 none）
non_diegetic_music: 配乐（无则 none）
4. 只输出提示词正文。'''

AUDIO_SFX_SYSTEM_PROMPT = '''你是文生音频/音效（SeedAudio 一类）提示词专家。把用户的声音需求写成可直接生成的声音描述。

输出结构：
subject_definitions: 声源与材料（是什么在发声、材质、尺寸）
summary: 一段话概述声音事件与整体听感
detailed_description: 按时间顺序描述声音的发生、变化、衰减，包含动作细节、力度、距离与空间
overall_soundscape: 空间与混响（室内/室外、反射、背景底噪）
non_diegetic_music: 若需要配乐则描述，否则写 none

要求：具体到材质、动作、力度与距离；避免抽象形容词；不写画面内容与镜头；只输出提示词正文。'''

IMAGE_SYSTEM_PROMPT_RULES = [
    {"key": "image_t2i", "kind": "image", "task_type": "t2i", "system_prompt": IMAGE_T2I_SYSTEM_PROMPT},
    {"key": "image_i2i", "kind": "image", "task_type": "i2i", "system_prompt": IMAGE_I2I_SYSTEM_PROMPT},
    {"key": "image_edit", "kind": "image", "task_type": "edit", "system_prompt": IMAGE_EDIT_SYSTEM_PROMPT},
]

AUDIO_SYSTEM_PROMPT_RULES = [
    {"key": "audio_tts", "kind": "audio", "task_type": "tts", "system_prompt": AUDIO_TTS_SYSTEM_PROMPT},
    {"key": "audio_clone", "kind": "audio", "task_type": "clone", "system_prompt": AUDIO_CLONE_SYSTEM_PROMPT},
    {"key": "audio_sfx", "kind": "audio", "task_type": "sfx", "system_prompt": AUDIO_SFX_SYSTEM_PROMPT},
]

MINIMAX_SYSTEM_PROMPT_OPTION_RULES = [
    {
        "key": "minimax_base",
        "format": "MiniMax",
        "modes": ["default", "l2v"],
        "system_prompt": MINIMAX_BASE_PROMPT,
    },
    {
        "key": "minimax_ref",
        "format": "MiniMax",
        "modes": ["ref", "edit"],
        "system_prompt": MINIMAX_REF_PROMPT,
    },
]
RETURN_RAW = "Return only the final enhanced prompt. Do not include explanations, greetings, or labels."
RETURN_JSON = "Return only a valid JSON object with one key: 'rewritten_text'. Do not include markdown fences."

def get_system_prompt_for_task(task_type: str) -> str:
    """Return the system-prompt prefix for `task_type` (default if unknown)."""
    return SYSTEM_PROMPTS.get(task_type, SYSTEM_PROMPTS["default"])


def get_prompt_template_for_task(task_type: str) -> str:
    """Return the editable prompt template for `task_type` (default if unknown)."""
    return PROMPT_TEMPLATES.get(task_type, SYSTEM_PROMPTS["default"])


def get_system_prompt_options(project_kind: str | None = None) -> list[dict]:
    """Return frontend-selectable system prompt defaults for the given project kind."""
    kind = str(project_kind or "").strip().lower()
    if kind == "image":
        return [dict(rule) for rule in IMAGE_SYSTEM_PROMPT_RULES]
    if kind == "audio":
        return [dict(rule) for rule in AUDIO_SYSTEM_PROMPT_RULES]
    options = [
        {
            **rule,
            "system_prompt": get_prompt_template_for_task(str(rule["task_type"])),
        }
        for rule in SYSTEM_PROMPT_OPTION_RULES
    ]
    return options + MINIMAX_SYSTEM_PROMPT_OPTION_RULES


def _media_count(value) -> int:
    if value is None:
        return 0
    if isinstance(value, torch.Tensor):
        if value.ndim == 4:
            return int(value.shape[0])
        return 1
    if isinstance(value, (list, tuple)):
        return len(value)
    return 1


def _format_prompt_template(template: str, **values: object) -> str:
    """Replace supported prompt placeholders while preserving other braces."""
    for key, value in values.items():
        template = template.replace("{" + key + "}", str(value))
    return template


def build_prompt_request(
    task_type: str,
    user_prompt: str,
    video: object = None,
    image: object = None,
    images: object = None,
    video_frames: int = DEFAULT_VIDEO_FRAMES,
    custom_system_prompt: str | None = None,
    json_mode: bool = False,
    video_format: str | None = None,
    task_mode: str | None = None,
) -> tuple[str, str, bool]:
    """Return the official system/user prompt pair for an external API node."""
    user_prompt = (user_prompt or "").strip()
    if video_format == "MiniMax":
        uses_base_prompt = (
            task_mode in {"default", "l2v"}
            if task_mode is not None
            else task_type in {"t2v", "i2v", "l2v"}
        )
        default_system_prompt = MINIMAX_BASE_PROMPT if uses_base_prompt else MINIMAX_REF_PROMPT
        return custom_system_prompt or default_system_prompt, user_prompt, False
    ref_count = (1 if image is not None else 0) + _media_count(images)
    video_count = min(max(int(video_frames), 1), max(_media_count(video), 1))
    image_num = ref_count
    base_sys = SYSTEM_PROMPTS["default"]

    count = image_num if image_num else min(video_count, 1)

    if task_type == "t2v":
        return custom_system_prompt or T2V_TEMPLATE, user_prompt, False
    if task_type in ("i2v", "defalt"):
        template = custom_system_prompt or I2V_TEMPLATE
        return base_sys, _format_prompt_template(template, user_prompt=user_prompt, image_num=max(count, 1)), False
    if task_type in ("v2v", "mv2v"):
        template = custom_system_prompt or V2V_TEMPLATE
        return base_sys, _format_prompt_template(template, user_prompt=user_prompt), False
    if task_type == "ads2v":
        template = custom_system_prompt or ADS2V_TEMPLATE
        return base_sys, _format_prompt_template(template, user_prompt=user_prompt), False
    if task_type == "vi2v":
        template = custom_system_prompt or VI2V_TEMPLATE
        return base_sys, _format_prompt_template(template, user_prompt=user_prompt, image_num=image_num), False
    if task_type == "r2v":
        template = custom_system_prompt or R2V_TEMPLATE
        text = _format_prompt_template(template, image_num=max(image_num, 1), original_text=user_prompt, return_format=RETURN_JSON if json_mode else RETURN_RAW)
        return base_sys, text, json_mode
    if task_type in ("rv2v", "vrc2v"):
        template = custom_system_prompt or VR2V_TEMPLATE
        text = _format_prompt_template(template, image_num=max(image_num, 1), original_text=user_prompt, return_format=RETURN_JSON if json_mode else RETURN_RAW)
        return base_sys, text, json_mode

    logger.warning("unknown task_type=%r; using the raw prompt", task_type)
    return get_system_prompt_for_task(task_type), user_prompt, False

def build_llm_prompt(system_prompt: str, user_prompt: str, json_mode: bool = False) -> str:
    """Combine system/user prompts into one plain prompt for generic LLM nodes."""
    parts = [
        "Follow the system instructions and complete the user task.",
        "",
        "System instructions:",
        (system_prompt or "").strip(),
        "",
        "User task:",
        (user_prompt or "").strip(),
    ]
    if json_mode:
        parts.extend(
            [
                "",
                "Output requirements:",
                RETURN_JSON,
            ]
        )
    else:
        parts.extend(
            [
                "",
                "Output requirements:",
                RETURN_RAW,
            ]
        )
    return "\n".join(parts).strip()
