import { App, Modal, Setting } from 'obsidian';
import { LUCIDE_ICONS } from './LucideIcons';
import { BRAND_ICONS } from './BrandIcons';
import { DEV_ICONS } from './DevIcons';
import { BRAND_COLORS, DEV_ICON_COLORS } from './IconColors';

const EMOJI_CATEGORIES: Record<string, string[]> = {
  '★ Quick': ['🧠', '💡', '🎯', '🏆', '🔑', '📝', '📚', '🔬', '🎨', '💰', '📊', '🌍', '🚀', '⚡', '🔐', '🛡️', '🤖', '💎', '🌱', '🎮', '🎵', '📷', '🏋️', '✈️', '🏔️', '🌊', '🧬', '💊', '🎸', '🕯️', '🗺️', '⏰', '🎁', '👑', '🦁', '🐉', '🔭', '🧩', '🌸', '⚽', '🍕', '☕', '🍷', '🎬', '🎤', '🎧', '🖥️', '📱', '🔧', '🏠'],
  'Smileys': ['😀', '😃', '😄', '😁', '😅', '😂', '🤣', '😊', '😇', '🙂', '😉', '😌', '😍', '🥰', '😘', '😎', '🤩', '🥳', '😏', '🤔', '🤨', '😐', '😑', '😶', '🙄', '😮', '😲', '😳', '🥺', '😢', '😭', '😤', '😠', '🤬', '😈', '👿', '💀', '☠️', '💩', '🤡', '👹', '👺', '👻', '👽', '🤖'],
  'Gestures': ['👋', '🤚', '🖐️', '✋', '🖖', '👌', '🤌', '🤏', '✌️', '🤞', '🤟', '🤘', '🤙', '👈', '👉', '👆', '👇', '☝️', '👍', '👎', '✊', '👊', '🤛', '🤜', '👏', '🙌', '👐', '🤲', '🤝', '🙏', '✍️', '💪'],
  'People': ['👶', '👧', '🧒', '👦', '👩', '🧑', '👨', '👩‍🦱', '👨‍🦱', '👩‍🦰', '👨‍🦰', '👱‍♀️', '👱‍♂️', '👩‍🦳', '👨‍🦳', '👩‍🦲', '👨‍🦲', '🧔', '👵', '🧓', '👴', '👲', '👳‍♀️', '👳‍♂️', '🧕', '👮‍♀️', '👮‍♂️', '👷‍♀️', '👷‍♂️', '💂‍♀️', '💂‍♂️', '🕵️‍♀️', '🕵️‍♂️', '👩‍⚕️', '👨‍⚕️', '👩‍🌾', '👨‍🌾', '👩‍🍳', '👨‍🍳', '👩‍🎓', '👨‍🎓', '👩‍🎤', '👨‍🎤', '👩‍🏫', '👨‍🏫', '👩‍🏭', '👨‍🏭', '👩‍💻', '👨‍💻', '👩‍💼', '👨‍💼', '👩‍🔧', '👨‍🔧', '👩‍🔬', '👨‍🔬', '👩‍🎨', '👨‍🎨', '👩‍🚀', '👨‍🚀', '🧙‍♀️', '🧙‍♂️', '🧚‍♀️', '🧚‍♂️', '🧛‍♀️', '🧛‍♂️', '🧜‍♀️', '🧜‍♂️', '🧝‍♀️', '🧝‍♂️', '🧞‍♀️', '🧞‍♂️', '🧟‍♀️', '🧟‍♂️', '💆‍♀️', '💆‍♂️', '💇‍♀️', '💇‍♂️', '🚶‍♀️', '🚶‍♂️', '🧍‍♀️', '🧍‍♂️', '🧎‍♀️', '🧎‍♂️', '🏃‍♀️', '🏃‍♂️', '💃', '🕺', '🕴️', '👯‍♀️', '👯‍♂️'],
  'Animals': ['🐶', '🐱', '🐭', '🐹', '🐰', '🦊', '🐻', '🐼', '🐻‍❄️', '🐨', '🐯', '🦁', '🐮', '🐷', '🐸', '🐵', '🙈', '🙉', '🙊', '🐒', '🐔', '🐧', '🐦', '🐤', '🐣', '🐥', '🦆', '🦅', '🦉', '🦇', '🐺', '🐗', '🐴', '🦄', '🐝', '🪱', '🐛', '🦋', '🐌', '🐞', '🐜', '🪰', '🪲', '🪳', '🦟', '🦗', '🕷️', '🕸️', '🦂', '🐢', '🐍', '🦎', '🦖', '🦕', '🐙', '🦑', '🦐', '🦞', '🦀', '🐡', '🐠', '🐟', '🐬', '🐳', '🐋', '🦈', '🐊', '🐅', '🐆', '🦓', '🦍', '🦧', '🐘', '🦛', '🦏', '🐪', '🐫', '🦒', '🦘', '🦬', '🐃', '🐂', '🐄', '🐎', '🐖', '🐏', '🐑', '🦙', '🐐', '🦌', '🐕', '🐩', '🦮', '🐕‍🦺', '🐈', '🐈‍⬛', '🪶', '🐓', '🦃', '🦤', '🦚', '🦜', '🦢', '🦩', '🕊️', '🐇', '🦝', '🦨', '🦡', '🦫', '🦦', '🦥', '🐁', '🐀', '🐿️', '🦔'],
  'Nature': ['🌸', '💮', '🏵️', '🌹', '🥀', '🌺', '🌻', '🌼', '🌷', '🌱', '🪴', '🌲', '🌳', '🌴', '🌵', '🌾', '🌿', '☘️', '🍀', '🍁', '🍂', '🍃', '🍇', '🍈', '🍉', '🍊', '🍋', '🍌', '🍍', '🥭', '🍎', '🍏', '🍐', '🍑', '🍒', '🍓', '🫐', '🥝', '🍅', '🫒', '🥥', '🥑', '🍆', '🥔', '🥕', '🌽', '🌶️', '🫑', '🥒', '🥬', '🥦', '🧄', '🧅', '🍄', '🥜', '🌰', '🍞', '🥐', '🥖', '🫓', '🥨', '🥯', '🥞', '🧇', '🧀', '🍖', '🍗', '🥩', '🥓', '🍔', '🍟', '🍕', '🌭', '🥪', '🌮', '🌯', '🫔', '🥙', '🧆', '🥚', '🍳', '🥘', '🍲', '🫕', '🥣', '🥗', '🍿', '🧈', '🧂', '🥫', '🍱', '🍘', '🍙', '🍚', '🍛', '🍜', '🍝', '🍠', '🍢', '🍣', '🍤', '🍥', '🥮', '🍡', '🥟', '🥠', '🥡', '🦀', '🦞', '🦐', '🦑', '🦪', '🍦', '🍧', '🍨', '🍩', '🍪', '🎂', '🍰', '🧁', '🥧', '🍫', '🍬', '🍭', '🍮', '🍯', '🍼', '🥛', '☕', '🫖', '🍵', '🍶', '🍾', '🍷', '🍸', '🍹', '🍺', '🍻', '🥂', '🥃', '🥤', '🧋', '🧃', '🧉', '🧊'],
  'Activities': ['⚽', '🏀', '🏈', '⚾', '🥎', '🎾', '🏐', '🏉', '🥏', '🎱', '🪀', '🏓', '🏸', '🏒', '🏑', '🥍', '🏏', '🪃', '🥅', '⛳', '🪁', '🏹', '🎣', '🤿', '🥊', '🥋', '🎽', '🛹', '🛼', '🛷', '⛸️', '🥌', '🎿', '⛷️', '🏂', '🪂', '🏋️‍♀️', '🏋️‍♂️', '🤼‍♀️', '🤼‍♂️', '🤸‍♀️', '🤸‍♂️', '⛹️‍♀️', '⛹️‍♂️', '🤺', '🤾‍♀️', '🤾‍♂️', '🏌️‍♀️', '🏌️‍♂️', '🏇', '🧘‍♀️', '🧘‍♂️', '🏄‍♀️', '🏄‍♂️', '🏊‍♀️', '🏊‍♂️', '🤽‍♀️', '🤽‍♂️', '🚣‍♀️', '🚣‍♂️', '🧗‍♀️', '🧗‍♂️', '🚵‍♀️', '🚵‍♂️', '🚴‍♀️', '🚴‍♂️', '🏆', '🥇', '🥈', '🥉', '🏅', '🎖️', '🏵️', '🎗️', '🎫', '🎟️', '🎪', '🤹‍♀️', '🤹‍♂️', '🎭', '🩰', '🎨', '🎬', '🎤', '🎧', '🎼', '🎹', '🥁', '🪘', '🎷', '🎺', '🪗', '🎸', '🪕', '🎻', '🎲', '♟️', '🎯', '🎳', '🎮', '🎰', '🧩'],
  'Travel': ['🚗', '🚕', '🚙', '🚌', '🚎', '🏎️', '🚓', '🚑', '🚒', '🚐', '🛻', '🚚', '🚛', '🚜', '🦯', '🦽', '🦼', '🛴', '🚲', '🛵', '🏍️', '🛺', '🚨', '🚔', '🚍', '🚘', '🚖', '🚡', '🚠', '🚟', '🚃', '🚋', '🚞', '🚝', '🚄', '🚅', '🚈', '🚂', '🚆', '🚇', '🚊', '🚉', '✈️', '🛫', '🛬', '🛩️', '💺', '🛰️', '🚀', '🛸', '🚁', '🛶', '⛵', '🚤', '🛥️', '🛳️', '⛴️', '🚢', '⚓', '🪝', '⛽', '🚧', '🚦', '🚥', '🚏', '🗺️', '🗿', '🗽', '🗼', '🏰', '🏯', '🏟️', '🎡', '🎢', '🎠', '⛲', '⛱️', '🏖️', '🏝️', '🏜️', '🌋', '⛰️', '🏔️', '🗻', '🏕️', '⛺', '🛖', '🏠', '🏡', '🏘️', '🏚️', '🏗️', '🏭', '🏢', '🏬', '🏣', '🏤', '🏥', '🏦', '🏨', '🏪', '🏫', '🏩', '💒', '🏛️', '⛪', '🕌', '🕍', '🛕', '🕋', '⛩️', '🛤️', '🛣️', '🗾', '🎑', '🏞️', '🌅', '🌄', '🌠', '🎇', '🎆', '🌇', '🌆', '🏙️', '🌃', '🌌', '🌉', '🌁'],
  'Objects': ['⌚', '📱', '📲', '💻', '⌨️', '🖥️', '🖨️', '🖱️', '🖲️', '🕹️', '🗜️', '💽', '💾', '💿', '📀', '📼', '📷', '📸', '📹', '🎥', '📽️', '🎞️', '📞', '☎️', '📟', '📠', '📺', '📻', '🎙️', '🎚️', '🎛️', '🧭', '⏱️', '⏲️', '⏰', '🕰️', '⌛', '⏳', '📡', '🔋', '🔌', '💡', '🔦', '🕯️', '🪔', '🧯', '🛢️', '💸', '💵', '💴', '💶', '💷', '🪙', '💰', '💳', '💎', '⚖️', '🪜', '🧰', '🪛', '🔧', '🔨', '⚒️', '🛠️', '⛏️', '🪚', '🔩', '⚙️', '🪤', '🧱', '⛓️', '🧲', '🔫', '💣', '🧨', '🪓', '🔪', '🗡️', '⚔️', '🛡️', '🚬', '⚰️', '🪦', '⚱️', '🏺', '🔮', '📿', '🧿', '💈', '⚗️', '🔭', '🔬', '🕳️', '🩹', '🩺', '💊', '💉', '🩸', '🧠', '🫀', '🫁', '🧬', '🦠', '🧫', '🧪', '🌡️', '🧹', '🪠', '🧺', '🧻', '🚽', '🚰', '🚿', '🛁', '🛀', '🧼', '🪥', '🪒', '🧽', '🪣', '🧴', '🛎️', '🔑', '🗝️', '🚪', '🪑', '🛋️', '🛏️', '🛌', '🧸', '🪆', '🖼️', '🪞', '🪟', '🛍️', '🛒', '🎁', '🎈', '🎏', '🎀', '🪄', '🪅', '🎊', '🎉', '🎎', '🏮', '🎐', '🧧', '✉️', '📩', '📨', '📧', '💌', '📥', '📤', '📦', '🏷️', '🪧', '📪', '📫', '📬', '📭', '📮', '📯', '📜', '📃', '📄', '📑', '🧾', '📊', '📈', '📉', '🗒️', '🗓️', '📆', '📅', '🗑️', '📇', '🗃️', '🗳️', '🗄️', '📋', '📁', '📂', '🗂️', '🗞️', '📰', '📓', '📔', '📒', '📕', '📗', '📘', '📙', '📚', '📖', '🔖', '🧷', '🔗', '📎', '🖇️', '📐', '📏', '🧮', '📌', '📍', '✂️', '🖊️', '🖋️', '✒️', '🖌️', '🖍️', '📝', '✏️', '🔍', '🔎', '🔏', '🔐', '🔒', '🔓'],
  'Symbols': ['❤️', '🧡', '💛', '💚', '💙', '💜', '🖤', '🤍', '🤎', '💔', '❣️', '💕', '💞', '💓', '💗', '💖', '💘', '💝', '💟', '☮️', '✝️', '☪️', '🕉️', '☸️', '✡️', '🔯', '🕎', '☯️', '☦️', '🛐', '⛎', '♈', '♉', '♊', '♋', '♌', '♍', '♎', '♏', '♐', '♑', '♒', '♓', '🆔', '⚛️', '🉑', '☢️', '☣️', '📴', '📳', '🈶', '🈚', '🈸', '🈺', '🈷️', '✴️', '🆚', '💮', '🉐', '㊙️', '㊗️', '🈴', '🈵', '🈹', '🈲', '🅰️', '🅱️', '🆎', '🆑', '🅾️', '🆘', '❌', '⭕', '🛑', '⛔', '📛', '🚫', '💯', '💢', '♨️', '🚷', '🚯', '🚳', '🚱', '🔞', '📵', '🚭', '❗', '❕', '❓', '❔', '‼️', '⁉️', '🔅', '🔆', '〽️', '⚠️', '🚸', '🔱', '⚜️', '🔰', '♻️', '✅', '🈯', '💹', '❇️', '✳️', '❎', '🌐', '💠', 'Ⓜ️', '🌀', '💤', '🏧', '🚾', '♿', '🅿️', '🛗', '🈳', '🈂️', '🛂', '🛃', '🛄', '🛅', '🚹', '🚺', '🚼', '⚧️', '🚻', '🚮', '🎦', '📶', '🈁', '🔣', 'ℹ️', '🔤', '🔡', '🔠', '🆖', '🆗', '🆙', '🆒', '🆕', '🆓', '0️⃣', '1️⃣', '2️⃣', '3️⃣', '4️⃣', '5️⃣', '6️⃣', '7️⃣', '8️⃣', '9️⃣', '🔟', '🔢', '#️⃣', '*️⃣', '⏏️', '▶️', '⏸️', '⏯️', '⏹️', '⏺️', '⏭️', '⏮️', '⏩', '⏪', '⏫', '⏬', '◀️', '🔼', '🔽', '➡️', '⬅️', '⬆️', '⬇️', '↗️', '↘️', '↙️', '↖️', '↕️', '↔️', '↪️', '↩️', '⤴️', '⤵️', '🔀', '🔁', '🔂', '🔄', '🔃', '🎵', '🎶', '➕', '➖', '➗', '✖️', '🟰', '♾️', '💲', '💱', '™️', '©️', '®️', '👁️‍🗨️', '🔚', '🔙', '🔛', '🔝', '🔜', '〰️', '➰', '➿', '✔️', '☑️', '🔘', '🔴', '🟠', '🟡', '🟢', '🔵', '🟣', '⚫', '⚪', '🟤', '🔺', '🔻', '🔸', '🔹', '🔶', '🔷', '🔳', '🔲', '▪️', '▫️', '◾', '◽', '◼️', '◻️', '🟥', '🟧', '🟨', '🟩', '🟦', '🟪', '⬛', '⬜', '🟫', '🔈', '🔇', '🔉', '🔊', '🔔', '🔕', '📣', '📢', '💬', '💭', '🗯️', '♠️', '♣️', '♥️', '♦️', '🃏', '🎴', '🀄', '🕐', '🕑', '🕒', '🕓', '🕔', '🕕', '🕖', '🕗', '🕘', '🕙', '🕚', '🕛', '🕜', '🕝', '🕞', '🕟', '🕠', '🕡', '🕢', '🕣', '🕤', '🕥', '🕦', '🕧'],
  'Flags': ['🏳️', '🏴', '🏴‍☠️', '🏁', '🚩', '🎌', '🏳️‍🌈', '🏳️‍⚧️', '🇺🇳', '🇦🇫', '🇦🇱', '🇩🇿', '🇦🇸', '🇦🇩', '🇦🇴', '🇦🇮', '🇦🇶', '🇦🇬', '🇦🇷', '🇦🇲', '🇦🇼', '🇦🇺', '🇦🇹', '🇦🇿', '🇧🇸', '🇧🇭', '🇧🇩', '🇧🇧', '🇧🇾', '🇧🇪', '🇧🇿', '🇧🇯', '🇧🇲', '🇧🇹', '🇧🇴', '🇧🇦', '🇧🇼', '🇧🇷', '🇮🇴', '🇻🇬', '🇧🇳', '🇧🇬', '🇧🇫', '🇧🇮', '🇰🇭', '🇨🇲', '🇨🇦', '🇮🇨', '🇨🇻', '🇧🇶', '🇰🇾', '🇨🇫', '🇹🇩', '🇨🇱', '🇨🇳', '🇨🇽', '🇨🇨', '🇨🇴', '🇰🇲', '🇨🇬', '🇨🇩', '🇨🇰', '🇨🇷', '🇨🇮', '🇭🇷', '🇨🇺', '🇨🇼', '🇨🇾', '🇨🇿', '🇩🇰', '🇩🇯', '🇩🇲', '🇩🇴', '🇪🇨', '🇪🇬', '🇸🇻', '🇬🇶', '🇪🇷', '🇪🇪', '🇸🇿', '🇪🇹', '🇪🇺', '🇫🇰', '🇫🇴', '🇫🇯', '🇫🇮', '🇫🇷', '🇬🇫', '🇵🇫', '🇹🇫', '🇬🇦', '🇬🇲', '🇬🇪', '🇩🇪', '🇬🇭', '🇬🇮', '🇬🇷', '🇬🇱', '🇬🇩', '🇬🇵', '🇬🇺', '🇬🇹', '🇬🇬', '🇬🇳', '🇬🇼', '🇬🇾', '🇭🇹', '🇭🇳', '🇭🇰', '🇭🇺', '🇮🇸', '🇮🇳', '🇮🇩', '🇮🇷', '🇮🇶', '🇮🇪', '🇮🇲', '🇮🇱', '🇮🇹', '🇯🇲', '🇯🇵', '🎌', '🇯🇪', '🇯🇴', '🇰🇿', '🇰🇪', '🇰🇮', '🇽🇰', '🇰🇼', '🇰🇬', '🇱🇦', '🇱🇻', '🇱🇧', '🇱🇸', '🇱🇷', '🇱🇾', '🇱🇮', '🇱🇹', '🇱🇺', '🇲🇴', '🇲🇬', '🇲🇼', '🇲🇾', '🇲🇻', '🇲🇱', '🇲🇹', '🇲🇭', '🇲🇶', '🇲🇷', '🇲🇺', '🇾🇹', '🇲🇽', '🇫🇲', '🇲🇩', '🇲🇨', '🇲🇳', '🇲🇪', '🇲🇸', '🇲🇦', '🇲🇿', '🇲🇲', '🇳🇦', '🇳🇷', '🇳🇵', '🇳🇱', '🇳🇨', '🇳🇿', '🇳🇮', '🇳🇪', '🇳🇬', '🇳🇺', '🇳🇫', '🇰🇵', '🇲🇰', '🇲🇵', '🇳🇴', '🇴🇲', '🇵🇰', '🇵🇼', '🇵🇸', '🇵🇦', '🇵🇬', '🇵🇾', '🇵🇪', '🇵🇭', '🇵🇳', '🇵🇱', '🇵🇹', '🇵🇷', '🇶🇦', '🇷🇪', '🇷🇴', '🇷🇺', '🇷🇼', '🇼🇸', '🇸🇲', '🇸🇹', '🇸🇦', '🇸🇳', '🇷🇸', '🇸🇨', '🇸🇱', '🇸🇬', '🇸🇽', '🇸🇰', '🇸🇮', '🇬🇸', '🇸🇧', '🇸🇴', '🇿🇦', '🇰🇷', '🇸🇸', '🇪🇸', '🇱🇰', '🇧🇱', '🇸🇭', '🇰🇳', '🇱🇨', '🇵🇲', '🇻🇨', '🇸🇩', '🇸🇷', '🇸🇪', '🇨🇭', '🇸🇾', '🇹🇼', '🇹🇯', '🇹🇿', '🇹🇭', '🇹🇱', '🇹🇬', '🇹🇰', '🇹🇴', '🇹🇹', '🇹🇳', '🇹🇷', '🇹🇲', '🇹🇨', '🇹🇻', '🇻🇮', '🇺🇬', '🇺🇦', '🇦🇪', '🇬🇧', '🏴󠁧󠁢󠁥󠁮󠁧󠁿', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🏴󠁧󠁢󠁷󠁬󠁳󠁿', '🇺🇸', '🇺🇾', '🇺🇿', '🇻🇺', '🇻🇦', '🇻🇪', '🇻🇳', '🇼🇫', '🇪🇭', '🇾🇪', '🇿🇲', '🇿🇼'],
};

type TabType = 'emoji' | 'lucide' | 'brand' | 'dev';

/**
 * Modal for picking an icon (Emoji, Lucide, Brand, or Dev).
 */
export class IconPickerModal extends Modal {
  private onSelect: (iconName: string | null) => void;
  private searchInput: HTMLInputElement | null = null;
  private gridContainer: HTMLElement | null = null;
  private currentIcon: string | null;
  private activeTab: TabType = 'emoji';
  private tabContainer: HTMLElement | null = null;

  constructor(app: App, currentIcon: string | null, onSelect: (iconName: string | null) => void) {
    super(app);
    this.currentIcon = currentIcon;
    this.onSelect = onSelect;
    if (currentIcon) {
      if (LUCIDE_ICONS[currentIcon]) {
        this.activeTab = 'lucide';
      } else if (BRAND_ICONS[currentIcon]) {
        this.activeTab = 'brand';
      } else if (DEV_ICONS[currentIcon]) {
        this.activeTab = 'dev';
      } else {
        this.activeTab = 'emoji';
      }
    }
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass('vault-sync-icon-picker');

    contentEl.createEl('h2', { text: 'Choose Icon' });

    this.tabContainer = contentEl.createDiv({ cls: 'icon-picker-tabs' });
    this.renderTabs();

    const searchContainer = contentEl.createDiv({ cls: 'icon-picker-search' });
    this.searchInput = searchContainer.createEl('input', {
      type: 'text',
      placeholder: 'Search icons...',
      cls: 'icon-picker-search-input',
    });
    this.searchInput.addEventListener('input', () => this.renderGrid());

    if (this.currentIcon) {
      new Setting(contentEl)
        .setName('Remove current icon')
        .addButton(btn => btn
          .setButtonText('Remove')
          .setWarning()
          .onClick(() => {
            this.onSelect(null);
            this.close();
          }));
    }

    this.gridContainer = contentEl.createDiv({ cls: 'icon-picker-grid' });
    this.renderGrid();

    this.injectStyles();

    this.searchInput.focus();
  }

  private renderTabs(): void {
    if (!this.tabContainer) return;
    this.tabContainer.empty();

    const tabs: { type: TabType; label: string }[] = [
      { type: 'emoji', label: '😀 Emoji' },
      { type: 'lucide', label: '🔲 Lucide' },
      { type: 'brand', label: '🏢 Brand' },
    ];

    for (const tab of tabs) {
      const tabEl = this.tabContainer.createDiv({
        cls: `icon-picker-tab ${this.activeTab === tab.type ? 'is-active' : ''}`,
        text: tab.label
      });
      tabEl.addEventListener('click', () => {
        this.activeTab = tab.type;
        this.renderTabs();
        this.renderGrid();
      });
    }
  }

  private renderGrid(): void {
    if (!this.gridContainer) return;
    this.gridContainer.empty();

    const searchTerm = this.searchInput?.value.toLowerCase() || '';

    switch (this.activeTab) {
      case 'lucide':
        this.renderLucideGrid(searchTerm);
        break;
      case 'brand':
        this.renderSvgIconGrid(BRAND_ICONS, searchTerm, BRAND_COLORS);
        break;
      case 'dev':
        this.renderSvgIconGrid(DEV_ICONS, searchTerm, DEV_ICON_COLORS);
        break;
      default:
        this.renderEmojiGrid(searchTerm);
    }
  }

  private renderLucideGrid(searchTerm: string): void {
    if (!this.gridContainer) return;

    const iconNames = Object.keys(LUCIDE_ICONS);
    const filtered = searchTerm
      ? iconNames.filter(name => name.toLowerCase().includes(searchTerm))
      : iconNames;

    for (const iconName of filtered) {
      const iconEl = this.gridContainer.createDiv({ cls: 'icon-picker-item' });

      if (iconName === this.currentIcon) {
        iconEl.addClass('is-selected');
      }

      const svgPath = LUCIDE_ICONS[iconName];
      iconEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" fill="none">${svgPath}</svg>`;
      iconEl.setAttribute('title', iconName);

      iconEl.addEventListener('click', () => {
        this.onSelect(iconName);
        this.close();
      });
    }

    if (filtered.length === 0) {
      this.gridContainer.createEl('p', { text: 'No icons found', cls: 'icon-picker-empty' });
    }
  }

  private renderSvgIconGrid(icons: Record<string, string>, searchTerm: string, colorMap?: Record<string, string>): void {
    if (!this.gridContainer) return;

    const iconNames = Object.keys(icons);
    const filtered = searchTerm
      ? iconNames.filter(name => name.toLowerCase().includes(searchTerm))
      : iconNames;

    for (const iconName of filtered) {
      const iconEl = this.gridContainer.createDiv({ cls: 'icon-picker-item' });

      if (iconName === this.currentIcon) {
        iconEl.addClass('is-selected');
      }

      const svgPath = icons[iconName];
      const color = colorMap?.[iconName];
      const fillAttr = color ? `fill="${color}" style="color:${color}"` : 'fill="currentColor"';
      iconEl.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="20" height="20" ${fillAttr}>${svgPath}</svg>`;
      iconEl.setAttribute('title', iconName);

      iconEl.addEventListener('click', () => {
        this.onSelect(iconName);
        this.close();
      });
    }

    if (filtered.length === 0) {
      this.gridContainer.createEl('p', { text: 'No icons found', cls: 'icon-picker-empty' });
    }
  }

  private renderEmojiGrid(searchTerm: string): void {
    if (!this.gridContainer) return;

    for (const [category, emojis] of Object.entries(EMOJI_CATEGORIES)) {
      const filtered = searchTerm
        ? emojis.filter(e => e.includes(searchTerm) || category.toLowerCase().includes(searchTerm))
        : emojis;

      if (filtered.length === 0) continue;

      const categoryHeader = this.gridContainer.createDiv({ cls: 'icon-picker-category' });
      categoryHeader.setText(category);

      const categoryGrid = this.gridContainer.createDiv({ cls: 'icon-picker-category-grid' });

      for (const emoji of filtered) {
        const emojiEl = categoryGrid.createDiv({ cls: 'icon-picker-item icon-picker-emoji' });

        if (emoji === this.currentIcon) {
          emojiEl.addClass('is-selected');
        }

        emojiEl.setText(emoji);

        emojiEl.addEventListener('click', () => {
          this.onSelect(emoji);
          this.close();
        });
      }
    }

    if (this.gridContainer.children.length === 0) {
      this.gridContainer.createEl('p', { text: 'No emojis found', cls: 'icon-picker-empty' });
    }
  }

  private injectStyles(): void {
    const styleId = 'vault-sync-icon-picker-styles';
    if (document.getElementById(styleId)) return;

    const style = document.createElement('style');
    style.id = styleId;
    style.textContent = `
      .vault-sync-icon-picker {
        padding: 16px;
        min-width: 480px;
      }
      .vault-sync-icon-picker h2 {
        margin-top: 0;
        margin-bottom: 12px;
        font-size: 16px;
      }
      .icon-picker-tabs {
        display: flex;
        gap: 6px;
        margin-bottom: 12px;
        flex-wrap: wrap;
      }
      .icon-picker-tab {
        padding: 6px 14px;
        border-radius: 6px;
        cursor: pointer;
        background: var(--background-secondary);
        font-size: 13px;
        transition: background 0.15s;
        user-select: none;
      }
      .icon-picker-tab:hover {
        background: var(--background-modifier-hover);
      }
      .icon-picker-tab.is-active {
        background: var(--interactive-accent);
        color: var(--text-on-accent);
      }
      .icon-picker-search {
        margin-bottom: 12px;
      }
      .icon-picker-search-input {
        width: 100%;
        padding: 7px 12px;
        font-size: 14px;
        border: 1px solid var(--background-modifier-border);
        border-radius: 6px;
        background: var(--background-primary);
        color: var(--text-normal);
        box-sizing: border-box;
      }
      .icon-picker-grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(40px, 1fr));
        gap: 4px;
        max-height: 420px;
        overflow-y: auto;
        padding: 2px;
      }
      .icon-picker-category {
        grid-column: 1 / -1;
        font-weight: 600;
        margin: 10px 0 4px 0;
        color: var(--text-muted);
        font-size: 11px;
        text-transform: uppercase;
        letter-spacing: 0.05em;
      }
      .icon-picker-category:first-child {
        margin-top: 0;
      }
      .icon-picker-category-grid {
        grid-column: 1 / -1;
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(40px, 1fr));
        gap: 4px;
      }
      .icon-picker-item {
        display: flex;
        align-items: center;
        justify-content: center;
        height: 40px;
        border-radius: 6px;
        cursor: pointer;
        transition: background 0.12s;
        min-width: 0;
      }
      .icon-picker-item:hover {
        background: var(--background-modifier-hover);
      }
      .icon-picker-item.is-selected {
        background: var(--interactive-accent);
        color: var(--text-on-accent);
      }
      .icon-picker-item svg {
        width: 20px;
        height: 20px;
        flex-shrink: 0;
      }
      .icon-picker-emoji {
        font-size: 20px;
        line-height: 1;
      }
      .icon-picker-empty {
        grid-column: 1 / -1;
        text-align: center;
        color: var(--text-muted);
        padding: 24px;
        font-size: 14px;
      }
    `;
    document.head.appendChild(style);
  }

  onClose(): void {
    const { contentEl } = this;
    contentEl.empty();
  }
}
