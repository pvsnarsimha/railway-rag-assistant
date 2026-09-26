"""
i18n_notify.py
--------------
FEATURE: train notifications in the user's own language — English plus all
22 languages of the Eighth Schedule of the Constitution of India.

The phone / website stores the user's choice (Settings -> "Notification
language", also asked when "Read notifications aloud" is first ticked) and
sends it with the push token (push_store.device_tokens.lang). Every
running-status update, "arriving in ~10 min" alert and "bell switched off"
notice is then built from the templates below, so the visible notification
AND the text the phone reads aloud are in that language.

Station and train names stay as the railway writes them (Latin script) and
times stay as HH:MM, exactly like IRCTC / NTES bilingual boards.

Pure templates: no translation API, no network, nothing to rate-limit.
English is always sent alongside (data.speak_text_en) so the phone can
fall back to it when it has no voice for the chosen language.

NOTE: the less widely published languages (Bodo, Dogri, Kashmiri,
Konkani, Maithili, Manipuri, Santali, Sanskrit, Sindhi) should be reviewed
by a native speaker before a public release — edit the strings here, no
other code changes needed.
"""

from typing import Optional

# code -> (English name, native name). Order = what the picker shows.
LANGUAGES = {
    "en": ("English", "English"),
    "as": ("Assamese", "অসমীয়া"),
    "bn": ("Bengali", "বাংলা"),
    "brx": ("Bodo", "बड़ो"),
    "doi": ("Dogri", "डोगरी"),
    "gu": ("Gujarati", "ગુજરાતી"),
    "hi": ("Hindi", "हिन्दी"),
    "kn": ("Kannada", "ಕನ್ನಡ"),
    "ks": ("Kashmiri", "کٲشُر"),
    "kok": ("Konkani", "कोंकणी"),
    "mai": ("Maithili", "मैथिली"),
    "ml": ("Malayalam", "മലയാളം"),
    "mni": ("Manipuri", "মৈতৈলোন্"),
    "mr": ("Marathi", "मराठी"),
    "ne": ("Nepali", "नेपाली"),
    "or": ("Odia", "ଓଡ଼ିଆ"),
    "pa": ("Punjabi", "ਪੰਜਾਬੀ"),
    "sa": ("Sanskrit", "संस्कृतम्"),
    "sat": ("Santali", "संताली"),
    "sd": ("Sindhi", "سنڌي"),
    "ta": ("Tamil", "தமிழ்"),
    "te": ("Telugu", "తెలుగు"),
    "ur": ("Urdu", "اردو"),
}

EN = {
    "crossed_at": "Crossed {st} at {t}", "crossed": "Crossed {st}",
    "departed_at": "Departed {st} at {t}", "departed": "Departed {st}",
    "arrived_at": "Arrived at {st} at {t}", "arrived": "Arrived at {st}",
    "reached_at": "Reached {st} at {t}", "reached": "Reached {st}",
    "yet": "Yet to start", "km_to": "{km} km to {st}", "next": "Next: {st}",
    "halt": "Next halt {st}", "exp": "exp. {t}", "now": "arriving now", "in_min": "in {n} min",
    "on_time": "On time", "late_m": "{n} min late", "late_hm": "{h}h {m}m late",
    "updated": "Updated {t}",
    "appr_soon": "🚆 {train} arriving at {st} in ~{n} min",
    "appr_now": "🚆 {train} arriving at {st} any moment now",
    "appr_body": "Please be alert — the train will reach {st} in the next 5–10 minutes.",
    "bell_off": "Reached {st} at {t} · this station's alert is now switched off.",
    "bell_off_nt": "Reached {st} · this station's alert is now switched off.",
    "update_title": "Train {train} update",
}

T = {
    "hi": {
        "crossed_at": "{st} {t} पर पार किया", "crossed": "{st} पार किया",
        "departed_at": "{st} से {t} पर रवाना", "departed": "{st} से रवाना",
        "arrived_at": "{st} {t} पर पहुँची", "arrived": "{st} पहुँची",
        "reached_at": "{st} {t} पर पहुँच गई", "reached": "{st} पहुँच गई",
        "yet": "अभी रवाना नहीं हुई", "km_to": "{st} तक {km} किमी", "next": "अगला: {st}",
        "halt": "अगला ठहराव {st}", "exp": "अपेक्षित {t}", "now": "अभी पहुँच रही है", "in_min": "{n} मिनट में",
        "on_time": "समय पर", "late_m": "{n} मिनट देरी", "late_hm": "{h} घंटे {m} मिनट देरी",
        "updated": "अपडेट {t}",
        "appr_soon": "🚆 {train} लगभग {n} मिनट में {st} पहुँच रही है",
        "appr_now": "🚆 {train} किसी भी पल {st} पहुँच रही है",
        "appr_body": "कृपया सतर्क रहें — ट्रेन अगले 5–10 मिनट में {st} पहुँचेगी।",
        "bell_off": "{st} {t} पर पहुँच गई · इस स्टेशन का अलर्ट अब बंद है।",
        "bell_off_nt": "{st} पहुँच गई · इस स्टेशन का अलर्ट अब बंद है।",
        "update_title": "ट्रेन {train} अपडेट",
    },
    "te": {
        "crossed_at": "{t}కి {st} దాటింది", "crossed": "{st} దాటింది",
        "departed_at": "{t}కి {st} నుండి బయలుదేరింది", "departed": "{st} నుండి బయలుదేరింది",
        "arrived_at": "{t}కి {st} చేరింది", "arrived": "{st} చేరింది",
        "reached_at": "{t}కి {st} చేరుకుంది", "reached": "{st} చేరుకుంది",
        "yet": "ఇంకా బయలుదేరలేదు", "km_to": "{st}కి {km} కి.మీ", "next": "తర్వాత: {st}",
        "halt": "తదుపరి ఆగే స్టేషన్ {st}", "exp": "అంచనా {t}", "now": "ఇప్పుడే చేరుతోంది", "in_min": "{n} నిమిషాల్లో",
        "on_time": "సమయానికి", "late_m": "{n} నిమిషాలు ఆలస్యం", "late_hm": "{h} గం {m} ని ఆలస్యం",
        "updated": "నవీకరణ {t}",
        "appr_soon": "🚆 {train} సుమారు {n} నిమిషాల్లో {st} చేరుతుంది",
        "appr_now": "🚆 {train} ఏ క్షణమైనా {st} చేరుతుంది",
        "appr_body": "దయచేసి అప్రమత్తంగా ఉండండి — రైలు రాబోయే 5–10 నిమిషాల్లో {st} చేరుతుంది.",
        "bell_off": "{t}కి {st} చేరుకుంది · ఈ స్టేషన్ అలర్ట్ ఇప్పుడు ఆపివేయబడింది.",
        "bell_off_nt": "{st} చేరుకుంది · ఈ స్టేషన్ అలర్ట్ ఇప్పుడు ఆపివేయబడింది.",
        "update_title": "రైలు {train} అప్‌డేట్",
    },
    "ta": {
        "crossed_at": "{t} மணிக்கு {st} கடந்தது", "crossed": "{st} கடந்தது",
        "departed_at": "{t} மணிக்கு {st} இலிருந்து புறப்பட்டது", "departed": "{st} இலிருந்து புறப்பட்டது",
        "arrived_at": "{t} மணிக்கு {st} வந்தடைந்தது", "arrived": "{st} வந்தடைந்தது",
        "reached_at": "{t} மணிக்கு {st} சென்றடைந்தது", "reached": "{st} சென்றடைந்தது",
        "yet": "இன்னும் புறப்படவில்லை", "km_to": "{st} வரை {km} கி.மீ", "next": "அடுத்து: {st}",
        "halt": "அடுத்த நிறுத்தம் {st}", "exp": "எதிர்பார்ப்பு {t}", "now": "இப்போது வந்துகொண்டிருக்கிறது", "in_min": "{n} நிமிடங்களில்",
        "on_time": "சரியான நேரத்தில்", "late_m": "{n} நிமிடம் தாமதம்", "late_hm": "{h} மணி {m} நிமிடம் தாமதம்",
        "updated": "புதுப்பிப்பு {t}",
        "appr_soon": "🚆 {train} சுமார் {n} நிமிடங்களில் {st} வந்தடையும்",
        "appr_now": "🚆 {train} எந்த நேரத்திலும் {st} வந்தடையும்",
        "appr_body": "தயவுசெய்து கவனமாக இருங்கள் — ரயில் அடுத்த 5–10 நிமிடங்களில் {st} வந்தடையும்.",
        "bell_off": "{t} மணிக்கு {st} சென்றடைந்தது · இந்த நிலையத்தின் எச்சரிக்கை இப்போது அணைக்கப்பட்டது.",
        "bell_off_nt": "{st} சென்றடைந்தது · இந்த நிலையத்தின் எச்சரிக்கை இப்போது அணைக்கப்பட்டது.",
        "update_title": "ரயில் {train} புதுப்பிப்பு",
    },
    "kn": {
        "crossed_at": "{t}ಕ್ಕೆ {st} ದಾಟಿತು", "crossed": "{st} ದಾಟಿತು",
        "departed_at": "{t}ಕ್ಕೆ {st}ನಿಂದ ಹೊರಟಿತು", "departed": "{st}ನಿಂದ ಹೊರಟಿತು",
        "arrived_at": "{t}ಕ್ಕೆ {st} ತಲುಪಿತು", "arrived": "{st} ತಲುಪಿತು",
        "reached_at": "{t}ಕ್ಕೆ {st} ತಲುಪಿದೆ", "reached": "{st} ತಲುಪಿದೆ",
        "yet": "ಇನ್ನೂ ಹೊರಟಿಲ್ಲ", "km_to": "{st}ಗೆ {km} ಕಿ.ಮೀ", "next": "ಮುಂದಿನದು: {st}",
        "halt": "ಮುಂದಿನ ನಿಲ್ದಾಣ {st}", "exp": "ನಿರೀಕ್ಷಿತ {t}", "now": "ಈಗ ತಲುಪುತ್ತಿದೆ", "in_min": "{n} ನಿಮಿಷದಲ್ಲಿ",
        "on_time": "ಸಮಯಕ್ಕೆ ಸರಿಯಾಗಿ", "late_m": "{n} ನಿಮಿಷ ತಡ", "late_hm": "{h} ಗಂ {m} ನಿ ತಡ",
        "updated": "ನವೀಕರಣ {t}",
        "appr_soon": "🚆 {train} ಸುಮಾರು {n} ನಿಮಿಷದಲ್ಲಿ {st} ತಲುಪಲಿದೆ",
        "appr_now": "🚆 {train} ಯಾವುದೇ ಕ್ಷಣದಲ್ಲಿ {st} ತಲುಪಲಿದೆ",
        "appr_body": "ದಯವಿಟ್ಟು ಎಚ್ಚರವಾಗಿರಿ — ರೈಲು ಮುಂದಿನ 5–10 ನಿಮಿಷಗಳಲ್ಲಿ {st} ತಲುಪಲಿದೆ.",
        "bell_off": "{t}ಕ್ಕೆ {st} ತಲುಪಿದೆ · ಈ ನಿಲ್ದಾಣದ ಎಚ್ಚರಿಕೆ ಈಗ ಆಫ್ ಆಗಿದೆ.",
        "bell_off_nt": "{st} ತಲುಪಿದೆ · ಈ ನಿಲ್ದಾಣದ ಎಚ್ಚರಿಕೆ ಈಗ ಆಫ್ ಆಗಿದೆ.",
        "update_title": "ರೈಲು {train} ಅಪ್‌ಡೇಟ್",
    },
    "ml": {
        "crossed_at": "{t}ന് {st} കടന്നു", "crossed": "{st} കടന്നു",
        "departed_at": "{t}ന് {st}ൽ നിന്ന് പുറപ്പെട്ടു", "departed": "{st}ൽ നിന്ന് പുറപ്പെട്ടു",
        "arrived_at": "{t}ന് {st}ൽ എത്തി", "arrived": "{st}ൽ എത്തി",
        "reached_at": "{t}ന് {st}ൽ എത്തിച്ചേർന്നു", "reached": "{st}ൽ എത്തിച്ചേർന്നു",
        "yet": "ഇതുവരെ പുറപ്പെട്ടിട്ടില്ല", "km_to": "{st}ലേക്ക് {km} കി.മീ", "next": "അടുത്തത്: {st}",
        "halt": "അടുത്ത സ്റ്റോപ്പ് {st}", "exp": "പ്രതീക്ഷിക്കുന്നത് {t}", "now": "ഇപ്പോൾ എത്തുന്നു", "in_min": "{n} മിനിറ്റിൽ",
        "on_time": "കൃത്യസമയത്ത്", "late_m": "{n} മിനിറ്റ് വൈകി", "late_hm": "{h} മണിക്കൂർ {m} മിനിറ്റ് വൈകി",
        "updated": "പുതുക്കിയത് {t}",
        "appr_soon": "🚆 {train} ഏകദേശം {n} മിനിറ്റിൽ {st}ൽ എത്തും",
        "appr_now": "🚆 {train} ഏത് നിമിഷവും {st}ൽ എത്തും",
        "appr_body": "ദയവായി ശ്രദ്ധിക്കുക — ട്രെയിൻ അടുത്ത 5–10 മിനിറ്റിനുള്ളിൽ {st}ൽ എത്തും.",
        "bell_off": "{t}ന് {st}ൽ എത്തിച്ചേർന്നു · ഈ സ്റ്റേഷന്റെ അലേർട്ട് ഇപ്പോൾ ഓഫാണ്.",
        "bell_off_nt": "{st}ൽ എത്തിച്ചേർന്നു · ഈ സ്റ്റേഷന്റെ അലേർട്ട് ഇപ്പോൾ ഓഫാണ്.",
        "update_title": "ട്രെയിൻ {train} അപ്‌ഡേറ്റ്",
    },
    "bn": {
        "crossed_at": "{t}-এ {st} পার হয়েছে", "crossed": "{st} পার হয়েছে",
        "departed_at": "{t}-এ {st} থেকে ছেড়েছে", "departed": "{st} থেকে ছেড়েছে",
        "arrived_at": "{t}-এ {st} পৌঁছেছে", "arrived": "{st} পৌঁছেছে",
        "reached_at": "{t}-এ {st} পৌঁছে গেছে", "reached": "{st} পৌঁছে গেছে",
        "yet": "এখনও যাত্রা শুরু হয়নি", "km_to": "{st} পর্যন্ত {km} কিমি", "next": "পরবর্তী: {st}",
        "halt": "পরবর্তী স্টপ {st}", "exp": "আনুমানিক {t}", "now": "এখনই পৌঁছাচ্ছে", "in_min": "{n} মিনিটে",
        "on_time": "সময়মতো", "late_m": "{n} মিনিট দেরি", "late_hm": "{h} ঘণ্টা {m} মিনিট দেরি",
        "updated": "আপডেট {t}",
        "appr_soon": "🚆 {train} প্রায় {n} মিনিটে {st} পৌঁছাবে",
        "appr_now": "🚆 {train} যেকোনো মুহূর্তে {st} পৌঁছাবে",
        "appr_body": "অনুগ্রহ করে সতর্ক থাকুন — ট্রেনটি আগামী 5–10 মিনিটের মধ্যে {st} পৌঁছাবে।",
        "bell_off": "{t}-এ {st} পৌঁছে গেছে · এই স্টেশনের সতর্কতা এখন বন্ধ।",
        "bell_off_nt": "{st} পৌঁছে গেছে · এই স্টেশনের সতর্কতা এখন বন্ধ।",
        "update_title": "ট্রেন {train} আপডেট",
    },
    "as": {
        "crossed_at": "{t}ত {st} পাৰ হ'ল", "crossed": "{st} পাৰ হ'ল",
        "departed_at": "{t}ত {st}ৰ পৰা যাত্ৰা কৰিলে", "departed": "{st}ৰ পৰা যাত্ৰা কৰিলে",
        "arrived_at": "{t}ত {st} পালেহি", "arrived": "{st} পালেহি",
        "reached_at": "{t}ত {st} পালেহি", "reached": "{st} পালেহি",
        "yet": "এতিয়াও যাত্ৰা আৰম্ভ হোৱা নাই", "km_to": "{st}লৈ {km} কি.মি.", "next": "পৰৱৰ্তী: {st}",
        "halt": "পৰৱৰ্তী ৰখা ষ্টেচন {st}", "exp": "আনুমানিক {t}", "now": "এতিয়াই আহি আছে", "in_min": "{n} মিনিটত",
        "on_time": "সময়মতে", "late_m": "{n} মিনিট পলম", "late_hm": "{h} ঘণ্টা {m} মিনিট পলম",
        "updated": "আপডেট {t}",
        "appr_soon": "🚆 {train} প্ৰায় {n} মিনিটত {st} পাবহি",
        "appr_now": "🚆 {train} যিকোনো মুহূৰ্তত {st} পাবহি",
        "appr_body": "অনুগ্ৰহ কৰি সতৰ্ক থাকক — ৰেলখন অহা 5–10 মিনিটৰ ভিতৰত {st} পাবহি।",
        "bell_off": "{t}ত {st} পালেহি · এই ষ্টেচনৰ সতৰ্কবাণী এতিয়া বন্ধ।",
        "bell_off_nt": "{st} পালেহি · এই ষ্টেচনৰ সতৰ্কবাণী এতিয়া বন্ধ।",
        "update_title": "ৰেল {train} আপডেট",
    },
    "mr": {
        "crossed_at": "{t} वाजता {st} ओलांडले", "crossed": "{st} ओलांडले",
        "departed_at": "{t} वाजता {st} येथून सुटली", "departed": "{st} येथून सुटली",
        "arrived_at": "{t} वाजता {st} येथे पोहोचली", "arrived": "{st} येथे पोहोचली",
        "reached_at": "{t} वाजता {st} येथे पोहोचली", "reached": "{st} येथे पोहोचली",
        "yet": "अद्याप सुटली नाही", "km_to": "{st} पर्यंत {km} किमी", "next": "पुढील: {st}",
        "halt": "पुढील थांबा {st}", "exp": "अपेक्षित {t}", "now": "आता पोहोचत आहे", "in_min": "{n} मिनिटांत",
        "on_time": "वेळेवर", "late_m": "{n} मिनिटे उशीर", "late_hm": "{h} तास {m} मिनिटे उशीर",
        "updated": "अपडेट {t}",
        "appr_soon": "🚆 {train} सुमारे {n} मिनिटांत {st} येथे पोहोचेल",
        "appr_now": "🚆 {train} कोणत्याही क्षणी {st} येथे पोहोचेल",
        "appr_body": "कृपया सावध राहा — गाडी पुढील 5–10 मिनिटांत {st} येथे पोहोचेल.",
        "bell_off": "{t} वाजता {st} येथे पोहोचली · या स्थानकाचा अलर्ट आता बंद आहे.",
        "bell_off_nt": "{st} येथे पोहोचली · या स्थानकाचा अलर्ट आता बंद आहे.",
        "update_title": "गाडी {train} अपडेट",
    },
    "gu": {
        "crossed_at": "{t} વાગ્યે {st} પસાર કર્યું", "crossed": "{st} પસાર કર્યું",
        "departed_at": "{t} વાગ્યે {st}થી ઉપડી", "departed": "{st}થી ઉપડી",
        "arrived_at": "{t} વાગ્યે {st} પહોંચી", "arrived": "{st} પહોંચી",
        "reached_at": "{t} વાગ્યે {st} પહોંચી ગઈ", "reached": "{st} પહોંચી ગઈ",
        "yet": "હજી ઉપડી નથી", "km_to": "{st} સુધી {km} કિમી", "next": "આગળ: {st}",
        "halt": "આગામી સ્ટોપ {st}", "exp": "અપેક્ષિત {t}", "now": "હમણાં પહોંચી રહી છે", "in_min": "{n} મિનિટમાં",
        "on_time": "સમયસર", "late_m": "{n} મિનિટ મોડી", "late_hm": "{h} કલાક {m} મિનિટ મોડી",
        "updated": "અપડેટ {t}",
        "appr_soon": "🚆 {train} લગભગ {n} મિનિટમાં {st} પહોંચશે",
        "appr_now": "🚆 {train} ગમે તે ક્ષણે {st} પહોંચશે",
        "appr_body": "કૃપા કરીને સાવધ રહો — ટ્રેન આગામી 5–10 મિનિટમાં {st} પહોંચશે.",
        "bell_off": "{t} વાગ્યે {st} પહોંચી ગઈ · આ સ્ટેશનનું એલર્ટ હવે બંધ છે.",
        "bell_off_nt": "{st} પહોંચી ગઈ · આ સ્ટેશનનું એલર્ટ હવે બંધ છે.",
        "update_title": "ટ્રેન {train} અપડેટ",
    },
    "pa": {
        "crossed_at": "{t} ਵਜੇ {st} ਪਾਰ ਕੀਤਾ", "crossed": "{st} ਪਾਰ ਕੀਤਾ",
        "departed_at": "{t} ਵਜੇ {st} ਤੋਂ ਰਵਾਨਾ", "departed": "{st} ਤੋਂ ਰਵਾਨਾ",
        "arrived_at": "{t} ਵਜੇ {st} ਪਹੁੰਚੀ", "arrived": "{st} ਪਹੁੰਚੀ",
        "reached_at": "{t} ਵਜੇ {st} ਪਹੁੰਚ ਗਈ", "reached": "{st} ਪਹੁੰਚ ਗਈ",
        "yet": "ਅਜੇ ਰਵਾਨਾ ਨਹੀਂ ਹੋਈ", "km_to": "{st} ਤੱਕ {km} ਕਿਮੀ", "next": "ਅਗਲਾ: {st}",
        "halt": "ਅਗਲਾ ਠਹਿਰਾਅ {st}", "exp": "ਅੰਦਾਜ਼ਨ {t}", "now": "ਹੁਣੇ ਪਹੁੰਚ ਰਹੀ ਹੈ", "in_min": "{n} ਮਿੰਟ ਵਿੱਚ",
        "on_time": "ਸਮੇਂ ਸਿਰ", "late_m": "{n} ਮਿੰਟ ਦੇਰੀ", "late_hm": "{h} ਘੰਟੇ {m} ਮਿੰਟ ਦੇਰੀ",
        "updated": "ਅੱਪਡੇਟ {t}",
        "appr_soon": "🚆 {train} ਲਗਭਗ {n} ਮਿੰਟ ਵਿੱਚ {st} ਪਹੁੰਚੇਗੀ",
        "appr_now": "🚆 {train} ਕਿਸੇ ਵੀ ਪਲ {st} ਪਹੁੰਚੇਗੀ",
        "appr_body": "ਕਿਰਪਾ ਕਰਕੇ ਸੁਚੇਤ ਰਹੋ — ਰੇਲਗੱਡੀ ਅਗਲੇ 5–10 ਮਿੰਟਾਂ ਵਿੱਚ {st} ਪਹੁੰਚੇਗੀ।",
        "bell_off": "{t} ਵਜੇ {st} ਪਹੁੰਚ ਗਈ · ਇਸ ਸਟੇਸ਼ਨ ਦਾ ਅਲਰਟ ਹੁਣ ਬੰਦ ਹੈ।",
        "bell_off_nt": "{st} ਪਹੁੰਚ ਗਈ · ਇਸ ਸਟੇਸ਼ਨ ਦਾ ਅਲਰਟ ਹੁਣ ਬੰਦ ਹੈ।",
        "update_title": "ਰੇਲਗੱਡੀ {train} ਅੱਪਡੇਟ",
    },
    "or": {
        "crossed_at": "{t}ରେ {st} ଅତିକ୍ରମ କଲା", "crossed": "{st} ଅତିକ୍ରମ କଲା",
        "departed_at": "{t}ରେ {st}ରୁ ଛାଡିଲା", "departed": "{st}ରୁ ଛାଡିଲା",
        "arrived_at": "{t}ରେ {st} ପହଞ୍ଚିଲା", "arrived": "{st} ପହଞ୍ଚିଲା",
        "reached_at": "{t}ରେ {st} ପହଞ୍ଚିଗଲା", "reached": "{st} ପହଞ୍ଚିଗଲା",
        "yet": "ଏପର୍ଯ୍ୟନ୍ତ ଛାଡିନାହିଁ", "km_to": "{st} ପର୍ଯ୍ୟନ୍ତ {km} କି.ମି.", "next": "ପରବର୍ତ୍ତୀ: {st}",
        "halt": "ପରବର୍ତ୍ତୀ ଷ୍ଟପ୍ {st}", "exp": "ଆନୁମାନିକ {t}", "now": "ଏବେ ପହଞ୍ଚୁଛି", "in_min": "{n} ମିନିଟରେ",
        "on_time": "ଠିକ୍ ସମୟରେ", "late_m": "{n} ମିନିଟ୍ ବିଳମ୍ବ", "late_hm": "{h} ଘଣ୍ଟା {m} ମିନିଟ୍ ବିଳମ୍ବ",
        "updated": "ଅପଡେଟ୍ {t}",
        "appr_soon": "🚆 {train} ପ୍ରାୟ {n} ମିନିଟରେ {st} ପହଞ୍ଚିବ",
        "appr_now": "🚆 {train} ଯେକୌଣସି ମୁହୂର୍ତ୍ତରେ {st} ପହଞ୍ଚିବ",
        "appr_body": "ଦୟାକରି ସତର୍କ ରୁହନ୍ତୁ — ଟ୍ରେନ୍ ଆଗାମୀ 5–10 ମିନିଟରେ {st} ପହଞ୍ଚିବ।",
        "bell_off": "{t}ରେ {st} ପହଞ୍ଚିଗଲା · ଏହି ଷ୍ଟେସନର ଆଲର୍ଟ ଏବେ ବନ୍ଦ।",
        "bell_off_nt": "{st} ପହଞ୍ଚିଗଲା · ଏହି ଷ୍ଟେସନର ଆଲର୍ଟ ଏବେ ବନ୍ଦ।",
        "update_title": "ଟ୍ରେନ୍ {train} ଅପଡେଟ୍",
    },
    "ur": {
        "crossed_at": "{t} بجے {st} سے گزری", "crossed": "{st} سے گزری",
        "departed_at": "{t} بجے {st} سے روانہ", "departed": "{st} سے روانہ",
        "arrived_at": "{t} بجے {st} پہنچی", "arrived": "{st} پہنچی",
        "reached_at": "{t} بجے {st} پہنچ گئی", "reached": "{st} پہنچ گئی",
        "yet": "ابھی روانہ نہیں ہوئی", "km_to": "{st} تک {km} کلومیٹر", "next": "اگلا: {st}",
        "halt": "اگلا اسٹاپ {st}", "exp": "متوقع {t}", "now": "ابھی پہنچ رہی ہے", "in_min": "{n} منٹ میں",
        "on_time": "وقت پر", "late_m": "{n} منٹ تاخیر", "late_hm": "{h} گھنٹے {m} منٹ تاخیر",
        "updated": "اپڈیٹ {t}",
        "appr_soon": "🚆 {train} تقریباً {n} منٹ میں {st} پہنچے گی",
        "appr_now": "🚆 {train} کسی بھی لمحے {st} پہنچے گی",
        "appr_body": "براہ کرم ہوشیار رہیں — ٹرین اگلے 5–10 منٹ میں {st} پہنچے گی۔",
        "bell_off": "{t} بجے {st} پہنچ گئی · اس اسٹیشن کا الرٹ اب بند ہے۔",
        "bell_off_nt": "{st} پہنچ گئی · اس اسٹیشن کا الرٹ اب بند ہے۔",
        "update_title": "ٹرین {train} اپڈیٹ",
    },
    "ne": {
        "crossed_at": "{t} बजे {st} पार गर्‍यो", "crossed": "{st} पार गर्‍यो",
        "departed_at": "{t} बजे {st} बाट छुट्यो", "departed": "{st} बाट छुट्यो",
        "arrived_at": "{t} बजे {st} पुग्यो", "arrived": "{st} पुग्यो",
        "reached_at": "{t} बजे {st} पुगिसक्यो", "reached": "{st} पुगिसक्यो",
        "yet": "अझै छुटेको छैन", "km_to": "{st} सम्म {km} किमी", "next": "अर्को: {st}",
        "halt": "अर्को रोकाइ {st}", "exp": "अनुमानित {t}", "now": "अहिले आइपुग्दैछ", "in_min": "{n} मिनेटमा",
        "on_time": "समयमै", "late_m": "{n} मिनेट ढिला", "late_hm": "{h} घण्टा {m} मिनेट ढिला",
        "updated": "अपडेट {t}",
        "appr_soon": "🚆 {train} करिब {n} मिनेटमा {st} पुग्नेछ",
        "appr_now": "🚆 {train} जुनसुकै बेला {st} पुग्नेछ",
        "appr_body": "कृपया सतर्क रहनुहोस् — रेल अर्को 5–10 मिनेटमा {st} पुग्नेछ।",
        "bell_off": "{t} बजे {st} पुगिसक्यो · यो स्टेसनको अलर्ट अब बन्द छ।",
        "bell_off_nt": "{st} पुगिसक्यो · यो स्टेसनको अलर्ट अब बन्द छ।",
        "update_title": "रेल {train} अपडेट",
    },
    "kok": {
        "crossed_at": "{t} वरांचेर {st} पार केलें", "crossed": "{st} पार केलें",
        "departed_at": "{t} वरांचेर {st} सावन सुटली", "departed": "{st} सावन सुटली",
        "arrived_at": "{t} वरांचेर {st} पावली", "arrived": "{st} पावली",
        "reached_at": "{t} वरांचेर {st} पावली", "reached": "{st} पावली",
        "yet": "अजून सुटूंक ना", "km_to": "{st} मेरेन {km} किमी", "next": "फुडलें: {st}",
        "halt": "फुडलो थांबो {st}", "exp": "अपेक्षीत {t}", "now": "आतां पावता", "in_min": "{n} मिणटांनी",
        "on_time": "वेळार", "late_m": "{n} मिणटां उशीर", "late_hm": "{h} वरां {m} मिणटां उशीर",
        "updated": "अपडेट {t}",
        "appr_soon": "🚆 {train} सुमार {n} मिणटांनी {st} पावतली",
        "appr_now": "🚆 {train} खंयच्याय खिणाक {st} पावतली",
        "appr_body": "उपकार करून सावध रावात — गाडी फुडल्या 5–10 मिणटांनी {st} पावतली.",
        "bell_off": "{t} वरांचेर {st} पावली · ह्या स्टेशनाचो अलर्ट आतां बंद आसा.",
        "bell_off_nt": "{st} पावली · ह्या स्टेशनाचो अलर्ट आतां बंद आसा.",
        "update_title": "गाडी {train} अपडेट",
    },
    "mai": {
        "crossed_at": "{t} बजे {st} पार केलक", "crossed": "{st} पार केलक",
        "departed_at": "{t} बजे {st} सँ खुजल", "departed": "{st} सँ खुजल",
        "arrived_at": "{t} बजे {st} पहुँचल", "arrived": "{st} पहुँचल",
        "reached_at": "{t} बजे {st} पहुँचि गेल", "reached": "{st} पहुँचि गेल",
        "yet": "एखन धरि नहि खुजल", "km_to": "{st} धरि {km} किमी", "next": "अगिला: {st}",
        "halt": "अगिला ठहराव {st}", "exp": "अपेक्षित {t}", "now": "एखने पहुँचि रहल अछि", "in_min": "{n} मिनटमे",
        "on_time": "समय पर", "late_m": "{n} मिनट देरी", "late_hm": "{h} घंटा {m} मिनट देरी",
        "updated": "अपडेट {t}",
        "appr_soon": "🚆 {train} करीब {n} मिनटमे {st} पहुँचत",
        "appr_now": "🚆 {train} कोनो क्षण {st} पहुँचत",
        "appr_body": "कृपया सतर्क रहू — ट्रेन अगिला 5–10 मिनटमे {st} पहुँचत।",
        "bell_off": "{t} बजे {st} पहुँचि गेल · एहि स्टेशनक अलर्ट आब बंद अछि।",
        "bell_off_nt": "{st} पहुँचि गेल · एहि स्टेशनक अलर्ट आब बंद अछि।",
        "update_title": "ट्रेन {train} अपडेट",
    },
    "doi": {
        "crossed_at": "{t} बजे {st} पार कीता", "crossed": "{st} पार कीता",
        "departed_at": "{t} बजे {st} थमां रवाना", "departed": "{st} थमां रवाना",
        "arrived_at": "{t} बजे {st} पुज्जी", "arrived": "{st} पुज्जी",
        "reached_at": "{t} बजे {st} पुज्जी गेई", "reached": "{st} पुज्जी गेई",
        "yet": "अजें रवाना नेईं होई", "km_to": "{st} तगर {km} किमी", "next": "अगला: {st}",
        "halt": "अगला ठैहराऽ {st}", "exp": "अंदाजन {t}", "now": "हुनै पुज्जा दी ऐ", "in_min": "{n} मिंटें च",
        "on_time": "टाइम पर", "late_m": "{n} मिंट देर", "late_hm": "{h} घैंटे {m} मिंट देर",
        "updated": "अपडेट {t}",
        "appr_soon": "🚆 {train} लगभग {n} मिंटें च {st} पुज्जग",
        "appr_now": "🚆 {train} कुसै बी पल {st} पुज्जग",
        "appr_body": "किरपा करियै सचेत रौह — गड्डी अगले 5–10 मिंटें च {st} पुज्जग।",
        "bell_off": "{t} बजे {st} पुज्जी गेई · इस स्टेशन दा अलर्ट हून बंद ऐ।",
        "bell_off_nt": "{st} पुज्जी गेई · इस स्टेशन दा अलर्ट हून बंद ऐ।",
        "update_title": "गड्डी {train} अपडेट",
    },
    "brx": {
        "crossed_at": "{t} आव {st} खौ गाबखांबाय", "crossed": "{st} खौ गाबखांबाय",
        "departed_at": "{t} आव {st} निफ्राय थांबाय", "departed": "{st} निफ्राय थांबाय",
        "arrived_at": "{t} आव {st} आव सौहैबाय", "arrived": "{st} आव सौहैबाय",
        "reached_at": "{t} आव {st} आव सौहैबाय", "reached": "{st} आव सौहैबाय",
        "yet": "दासिमबो थांखांखै", "km_to": "{st} सिम {km} किमी", "next": "उननि: {st}",
        "halt": "उननि थाबथि {st}", "exp": "सानखांनाय {t}", "now": "दानो सौहैगासिनो दं", "in_min": "{n} मिनिटआव",
        "on_time": "समाव", "late_m": "{n} मिनिट गोजान", "late_hm": "{h} घन्टा {m} मिनिट गोजान",
        "updated": "आपडेट {t}",
        "appr_soon": "🚆 {train} {n} मिनिटआव {st} आव सौहैगोन",
        "appr_now": "🚆 {train} जायखिजाया समाव {st} आव सौहैगोन",
        "appr_body": "अननानै सावधान जा — रेलगाडिया उननि 5–10 मिनिटनि गेजेराव {st} आव सौहैगोन।",
        "bell_off": "{t} आव {st} आव सौहैबाय · बे स्टेसननि सांग्रांथि दा बन्द।",
        "bell_off_nt": "{st} आव सौहैबाय · बे स्टेसननि सांग्रांथि दा बन्द।",
        "update_title": "रेल {train} आपडेट",
    },
    "sa": {
        "crossed_at": "{t} वादने {st} अतिक्रान्तम्", "crossed": "{st} अतिक्रान्तम्",
        "departed_at": "{t} वादने {st} तः प्रस्थितम्", "departed": "{st} तः प्रस्थितम्",
        "arrived_at": "{t} वादने {st} प्राप्तम्", "arrived": "{st} प्राप्तम्",
        "reached_at": "{t} वादने {st} प्राप्तम्", "reached": "{st} प्राप्तम्",
        "yet": "अद्यापि न प्रस्थितम्", "km_to": "{st} पर्यन्तं {km} किमी", "next": "अग्रिमम्: {st}",
        "halt": "अग्रिमः विरामः {st}", "exp": "अपेक्षितम् {t}", "now": "इदानीम् आगच्छति", "in_min": "{n} निमेषेषु",
        "on_time": "यथासमयम्", "late_m": "{n} निमेषाः विलम्बः", "late_hm": "{h} होराः {m} निमेषाः विलम्बः",
        "updated": "नवीकरणम् {t}",
        "appr_soon": "🚆 {train} प्रायः {n} निमेषेषु {st} प्राप्स्यति",
        "appr_now": "🚆 {train} कस्मिन्नपि क्षणे {st} प्राप्स्यति",
        "appr_body": "कृपया सावधानाः भवन्तु — रेलयानम् आगामिषु 5–10 निमेषेषु {st} प्राप्स्यति।",
        "bell_off": "{t} वादने {st} प्राप्तम् · अस्य स्थानकस्य सूचना इदानीं निष्क्रिया।",
        "bell_off_nt": "{st} प्राप्तम् · अस्य स्थानकस्य सूचना इदानीं निष्क्रिया।",
        "update_title": "रेलयानम् {train} नवीकरणम्",
    },
    "sat": {
        "crossed_at": "{t} बाजे {st} पार एना", "crossed": "{st} पार एना",
        "departed_at": "{t} बाजे {st} खोन चालाक् एना", "departed": "{st} खोन चालाक् एना",
        "arrived_at": "{t} बाजे {st} सेटेर एना", "arrived": "{st} सेटेर एना",
        "reached_at": "{t} बाजे {st} सेटेर एना", "reached": "{st} सेटेर एना",
        "yet": "नितोगे बाय चालाक् आकाना", "km_to": "{st} हाबिच् {km} किमी", "next": "तायोम: {st}",
        "halt": "तायोम तिंगु ठाँव {st}", "exp": "आंदाज {t}", "now": "नित सेटेर कान", "in_min": "{n} मिनिट रे",
        "on_time": "ओकतो रे", "late_m": "{n} मिनिट देरी", "late_hm": "{h} घंटा {m} मिनिट देरी",
        "updated": "अपडेट {t}",
        "appr_soon": "🚆 {train} {n} मिनिट रे {st} सेटेरोक्",
        "appr_now": "🚆 {train} जाहान घड़ी {st} सेटेरोक्",
        "appr_body": "दया काते होस रे ताहेंन पे — रेल तायोम 5–10 मिनिट रे {st} सेटेरोक्।",
        "bell_off": "{t} बाजे {st} सेटेर एना · नोवा स्टेसन रेयाक् अलर्ट नित बंद।",
        "bell_off_nt": "{st} सेटेर एना · नोवा स्टेसन रेयाक् अलर्ट नित बंद।",
        "update_title": "रेल {train} अपडेट",
    },
    "sd": {
        "crossed_at": "{t} وڳي {st} پار ڪيو", "crossed": "{st} پار ڪيو",
        "departed_at": "{t} وڳي {st} کان روانو", "departed": "{st} کان روانو",
        "arrived_at": "{t} وڳي {st} پهتي", "arrived": "{st} پهتي",
        "reached_at": "{t} وڳي {st} پهچي وئي", "reached": "{st} پهچي وئي",
        "yet": "اڃا روانو نه ٿي آهي", "km_to": "{st} تائين {km} ڪلوميٽر", "next": "اڳيون: {st}",
        "halt": "اڳيون اسٽاپ {st}", "exp": "متوقع {t}", "now": "هاڻي پهچي رهي آهي", "in_min": "{n} منٽن ۾",
        "on_time": "وقت تي", "late_m": "{n} منٽ دير", "late_hm": "{h} ڪلاڪ {m} منٽ دير",
        "updated": "اپڊيٽ {t}",
        "appr_soon": "🚆 {train} لڳ ڀڳ {n} منٽن ۾ {st} پهچندي",
        "appr_now": "🚆 {train} ڪنهن به گهڙي {st} پهچندي",
        "appr_body": "مهرباني ڪري هوشيار رهو — ريل ايندڙ 5–10 منٽن ۾ {st} پهچندي.",
        "bell_off": "{t} وڳي {st} پهچي وئي · هن اسٽيشن جو الرٽ هاڻي بند آهي.",
        "bell_off_nt": "{st} پهچي وئي · هن اسٽيشن جو الرٽ هاڻي بند آهي.",
        "update_title": "ريل {train} اپڊيٽ",
    },
    "ks": {
        "crossed_at": "{t} بجہ {st} کٔر پار", "crossed": "{st} کٔر پار",
        "departed_at": "{t} بجہ {st} پیٚٹھٕ روانہٕ", "departed": "{st} پیٚٹھٕ روانہٕ",
        "arrived_at": "{t} بجہ {st} واتیٚو", "arrived": "{st} واتیٚو",
        "reached_at": "{t} بجہ {st} واتیٚو", "reached": "{st} واتیٚو",
        "yet": "وۄنۍ چھےٚ نہٕ روانہٕ گٔمٕژ", "km_to": "{st} تام {km} کلومیٹر", "next": "بییہ: {st}",
        "halt": "بییہ ٹھہراو {st}", "exp": "متوقع {t}", "now": "وۄنۍ چھےٚ واتان", "in_min": "{n} منٹن منٛز",
        "on_time": "وقتس پیٚٹھ", "late_m": "{n} منٹ دیر", "late_hm": "{h} گھنٹہٕ {m} منٹ دیر",
        "updated": "اپڈیٹ {t}",
        "appr_soon": "🚆 {train} تقریباً {n} منٹن منٛز {st} واتہِ",
        "appr_now": "🚆 {train} کُنہِ تہِ وِزِ {st} واتہِ",
        "appr_body": "مہربٲنی کٔرِتھ ہوشیار روزِو — ریل واتہِ 5–10 منٹن منٛز {st}۔",
        "bell_off": "{t} بجہ {st} واتیٚو · یِتھ سٹیشنُک الرٹ چھُ وۄنۍ بند۔",
        "bell_off_nt": "{st} واتیٚو · یِتھ سٹیشنُک الرٹ چھُ وۄنۍ بند۔",
        "update_title": "ریل {train} اپڈیٹ",
    },
    "mni": {
        "crossed_at": "{t}দা {st} চৎলে", "crossed": "{st} চৎলে",
        "departed_at": "{t}দা {st}দগী হৌরে", "departed": "{st}দগী হৌরে",
        "arrived_at": "{t}দা {st} য়ৌরে", "arrived": "{st} য়ৌরে",
        "reached_at": "{t}দা {st} য়ৌরে", "reached": "{st} য়ৌরে",
        "yet": "হৌদ্রিঙেই", "km_to": "{st} ফাওবা {km} কি.মি.", "next": "মথংগী: {st}",
        "halt": "মথংগী লেপ্পা মফম {st}", "exp": "থাজবা {t}", "now": "হৌজিক য়ৌরিবনি", "in_min": "মিনিট {n}দা",
        "on_time": "মতম চানা", "late_m": "মিনিট {n} শোত্থরে", "late_hm": "পুং {h} মিনিট {m} শোত্থরে",
        "updated": "অপডেট {t}",
        "appr_soon": "🚆 {train} মিনিট {n}দা {st} য়ৌগনি",
        "appr_now": "🚆 {train} কদায়দা য়ৌরবসু {st} য়ৌগনি",
        "appr_body": "চানবিদুনা চেকশিনবিয়ু — ট্রেন অসি লাক্কদবা মিনিট 5–10গী মনুংদা {st} য়ৌগনি।",
        "bell_off": "{t}দা {st} য়ৌরে · স্টেসন অসিগী এলার্ট হৌজিক থিংলে।",
        "bell_off_nt": "{st} য়ৌরে · স্টেসন অসিগী এলার্ট হৌজিক থিংলে।",
        "update_title": "ট্রেন {train} অপডেট",
    },
}


def normalize(lang: Optional[str]) -> str:
    code = str(lang or "").strip().lower().split("-")[0]
    return code if code in LANGUAGES else "en"


def phrase(lang: Optional[str], key: str, **kw) -> str:
    table = T.get(normalize(lang)) or EN
    tpl = table.get(key) or EN[key]
    try:
        return tpl.format(**kw)
    except (KeyError, IndexError):
        return EN[key].format(**kw)


def delay_phrase(minutes: Optional[int], lang: Optional[str]) -> Optional[str]:
    if minutes is None:
        return None
    if minutes <= 0:
        return phrase(lang, "on_time")
    h, m = divmod(int(minutes), 60)
    return phrase(lang, "late_hm", h=h, m=m) if h else phrase(lang, "late_m", n=m)


def headline(rs: dict, lang: Optional[str]) -> str:
    """Same content as running_status.headline, in `lang`."""
    if not rs:
        return ""
    if rs.get("completed"):
        st = rs.get("destination") or ""
        t = rs.get("destination_eta")
        return phrase(lang, "reached_at", st=st, t=t) if t else phrase(lang, "reached", st=st)
    parts = []
    if rs.get("crossed_station"):
        verb = {"Departed": "departed", "Arrived at": "arrived", "Reached": "reached"}.get(
            rs.get("crossed_verb") or "", "crossed")
        st, t = rs["crossed_station"], rs.get("crossed_time")
        parts.append(phrase(lang, f"{verb}_at", st=st, t=t) if t else phrase(lang, verb, st=st))
    else:
        parts.append(phrase(lang, "yet"))
    if rs.get("next_station"):
        if rs.get("km_to_next") is not None:
            parts.append(phrase(lang, "km_to", km=f"{rs['km_to_next']:g}", st=rs["next_station"]))
        else:
            parts.append(phrase(lang, "next", st=rs["next_station"]))
    return " · ".join(parts)


def detail(rs: dict, lang: Optional[str]) -> str:
    if not rs or rs.get("completed") or not rs.get("next_halt"):
        return ""
    bits = [phrase(lang, "halt", st=rs["next_halt"])]
    if rs.get("next_halt_eta"):
        bits.append(phrase(lang, "exp", t=rs["next_halt_eta"]))
        mins = rs.get("next_halt_minutes")
        if mins is not None and mins <= 90:
            bits.append(phrase(lang, "now") if mins < 1 else phrase(lang, "in_min", n=int(mins)))
    dp = delay_phrase(rs.get("next_halt_delay"), lang)
    if dp:
        bits.append(dp)
    return " · ".join(bits)


def running_texts(train_number: str, rs: dict, lang: Optional[str], hhmm: str) -> tuple:
    """(title, body) for a running-status notification in `lang`."""
    name = rs.get("train_name")
    dp = delay_phrase(rs.get("delay_minutes"), lang)
    title = f"{train_number}" + (f" {name}" if name else "") + (f" · {dp}" if dp else "")
    lines = [headline(rs, lang) or "…"]
    d = detail(rs, lang)
    if d:
        lines.append(d)
    lines.append(phrase(lang, "updated", t=hhmm))
    return title, "\n".join(lines)
