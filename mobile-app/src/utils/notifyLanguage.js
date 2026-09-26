// notifyLanguage.js
// -----------------
// FEATURE: notifications shown AND read aloud in the user's own language —
// English + all 22 languages of the Eighth Schedule. The choice is kept on
// the device and sent to the server with the push token, which builds each
// notification in that language (backend/i18n_notify.py).
//
// `tts` is the text-to-speech locale; `fallback` is used when the phone has
// no voice for it (e.g. a Devanagari-script language read by the Hindi
// voice). With no usable voice at all, the English text is read instead.

import AsyncStorage from "@react-native-async-storage/async-storage";

export const LANGUAGE_KEY = "notify.language";

export const LANGUAGES = [
  { code: "en", name: "English", native: "English", tts: "en-IN" },
  { code: "as", name: "Assamese", native: "অসমীয়া", tts: "as-IN", fallback: "bn-IN" },
  { code: "bn", name: "Bengali", native: "বাংলা", tts: "bn-IN" },
  { code: "brx", name: "Bodo", native: "बड़ो", tts: "brx-IN", fallback: "hi-IN" },
  { code: "doi", name: "Dogri", native: "डोगरी", tts: "doi-IN", fallback: "hi-IN" },
  { code: "gu", name: "Gujarati", native: "ગુજરાતી", tts: "gu-IN" },
  { code: "hi", name: "Hindi", native: "हिन्दी", tts: "hi-IN" },
  { code: "kn", name: "Kannada", native: "ಕನ್ನಡ", tts: "kn-IN" },
  { code: "ks", name: "Kashmiri", native: "کٲشُر", tts: "ks-IN", fallback: "ur-IN" },
  { code: "kok", name: "Konkani", native: "कोंकणी", tts: "kok-IN", fallback: "mr-IN" },
  { code: "mai", name: "Maithili", native: "मैथिली", tts: "mai-IN", fallback: "hi-IN" },
  { code: "ml", name: "Malayalam", native: "മലയാളം", tts: "ml-IN" },
  { code: "mni", name: "Manipuri", native: "মৈতৈলোন্", tts: "mni-IN", fallback: "bn-IN" },
  { code: "mr", name: "Marathi", native: "मराठी", tts: "mr-IN" },
  { code: "ne", name: "Nepali", native: "नेपाली", tts: "ne-NP", fallback: "hi-IN" },
  { code: "or", name: "Odia", native: "ଓଡ଼ିଆ", tts: "or-IN" },
  { code: "pa", name: "Punjabi", native: "ਪੰਜਾਬੀ", tts: "pa-IN" },
  { code: "sa", name: "Sanskrit", native: "संस्कृतम्", tts: "sa-IN", fallback: "hi-IN" },
  { code: "sat", name: "Santali", native: "संताली", tts: "sat-IN", fallback: "hi-IN" },
  { code: "sd", name: "Sindhi", native: "سنڌي", tts: "sd-IN", fallback: "ur-IN" },
  { code: "ta", name: "Tamil", native: "தமிழ்", tts: "ta-IN" },
  { code: "te", name: "Telugu", native: "తెలుగు", tts: "te-IN" },
  { code: "ur", name: "Urdu", native: "اردو", tts: "ur-IN" },
];

export function languageInfo(code) {
  return LANGUAGES.find((l) => l.code === code) || LANGUAGES[0];
}

let current = null; // null = the user hasn't chosen yet

/** Sync read of the cached choice ("en" until loaded / chosen). */
export function getLanguage() {
  return current || "en";
}

/** Has the user picked a language yet? (after loadLanguage()) */
export function hasChosenLanguage() {
  return !!current;
}

export async function loadLanguage() {
  try {
    const v = await AsyncStorage.getItem(LANGUAGE_KEY);
    if (v && LANGUAGES.some((l) => l.code === v)) current = v;
  } catch (e) { /* keep */ }
  return current;
}

export async function saveLanguage(code) {
  current = languageInfo(code).code;
  try { await AsyncStorage.setItem(LANGUAGE_KEY, current); } catch (e) { /* ignore */ }
  return current;
}

// Sample line shown in the picker and read once when a language is chosen,
// so the user can hear whether the phone has a voice for it.
export const SAMPLE = {
  en: "Read aloud is on. Train notifications will be read in English.",
  as: "ৰেলৰ জাননী এতিয়া অসমীয়াত পঢ়ি শুনোৱা হ'ব।",
  bn: "ট্রেনের বিজ্ঞপ্তি এখন বাংলায় পড়ে শোনানো হবে।",
  brx: "रेलनि खौरां दा बड़ो राव फरायनो जागोन।",
  doi: "गड्डी दियां सूचनां हून डोगरी च पढ़ियां जाङन।",
  gu: "ટ્રેનની સૂચનાઓ હવે ગુજરાતીમાં વાંચીને સંભળાવવામાં આવશે.",
  hi: "ट्रेन की सूचनाएँ अब हिन्दी में पढ़कर सुनाई जाएँगी।",
  kn: "ರೈಲಿನ ಸೂಚನೆಗಳನ್ನು ಈಗ ಕನ್ನಡದಲ್ಲಿ ಓದಿ ಹೇಳಲಾಗುತ್ತದೆ.",
  ks: "ریلہٕ ہٕنز اطلاع پرنہٕ یِیہِ وۄنۍ کٲشرِس منٛز۔",
  kok: "गाडयेचीं सुचोवण्यो आतां कोंकणींत वाचून दाखयतले.",
  mai: "ट्रेनक सूचना आब मैथिलीमे पढ़ि कऽ सुनाओल जाएत।",
  ml: "ട്രെയിൻ അറിയിപ്പുകൾ ഇനി മലയാളത്തിൽ വായിച്ചുകേൾപ്പിക്കും.",
  mni: "ট্রেনগী খবরশিং হৌজিকদগী মৈতৈলোনদা পাদুনা তাহল্লগনি।",
  mr: "गाडीच्या सूचना आता मराठीत वाचून दाखवल्या जातील.",
  ne: "रेलका सूचनाहरू अब नेपालीमा पढेर सुनाइनेछ।",
  or: "ଟ୍ରେନ୍ ସୂଚନା ଏବେ ଓଡ଼ିଆରେ ପଢ଼ି ଶୁଣାଯିବ।",
  pa: "ਰੇਲਗੱਡੀ ਦੀਆਂ ਸੂਚਨਾਵਾਂ ਹੁਣ ਪੰਜਾਬੀ ਵਿੱਚ ਪੜ੍ਹ ਕੇ ਸੁਣਾਈਆਂ ਜਾਣਗੀਆਂ।",
  sa: "रेलयानस्य सूचनाः इदानीं संस्कृतेन पठिष्यन्ते।",
  sat: "रेल रेयाक् खबोर नित संताली रे पाढ़ाव आ।",
  sd: "ريل جا نوٽيفڪيشن هاڻي سنڌيءَ ۾ پڙهي ٻڌايا ويندا.",
  ta: "ரயில் அறிவிப்புகள் இனி தமிழில் வாசிக்கப்படும்.",
  te: "రైలు నోటిఫికేషన్లు ఇకపై తెలుగులో చదివి వినిపించబడతాయి.",
  ur: "ٹرین کی اطلاعات اب اردو میں پڑھ کر سنائی جائیں گی۔",
};
