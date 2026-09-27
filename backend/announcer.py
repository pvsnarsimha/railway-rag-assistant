"""
announcer.py
------------
FEATURE: "Read notifications aloud" in the style of a railway-station
announcer, in English and all 22 languages of i18n_notify.LANGUAGES.

The visible notification stays short ("Crossed Eluru at 17:54 · 8.3 km to
Rajahmundry"). What the phone SPEAKS is built here instead, the way a
platform announcement sounds:

    "Attention please. Train number 1 2 7 9 7, Venkatadri Express, has
     crossed Eluru at 17 hours 54 minutes. It is 8 point 3 kilometres from
     Rajahmundry. Next halt Rajahmundry, expected at 18 hours 40 minutes,
     in 25 minutes. The train is running 15 minutes late. Thank you."

  * Numbers are spelled for speech: a decimal distance is read "8 point 3
    kilometres" (in each language's own words), never "8.3 km" (which TTS
    engines read as a date, "eight three", or "k m").
  * Train numbers are read digit by digit, like at the station.
  * Times are read as hours and minutes.
  * Station and village names are written in the language's OWN script
    (Telugu voice gets "ఏలూరు", Hindi voice gets "एलूरु"), so the voice
    pronounces them like a local does instead of spelling English letters
    or guessing at an English word. Well-known stations whose English
    spelling doesn't match how they're said use a curated pronunciation
    (STATION_SAY); every other name goes through a rule-based transliterator.
    Urdu / Kashmiri / Sindhi keep the Roman spelling (their voices read it).

Pure Python, no network. The less widely published languages share the
NOTE in i18n_notify.py: have a native speaker review the strings below.
"""

import re
from typing import Optional

import i18n_notify

# ---------------------------------------------------------------------------
# Announcement phrases. {num} digit-by-digit train number, {name} train name,
# {st} station (in the language's script), {t} spoken time, {km} spoken
# distance, {n}/{h}/{m} numbers.
# ---------------------------------------------------------------------------
EN_ANN = {
    "intro": "Attention please.",
    "train": "Train number {num}{name}",
    "crossed_at": "has crossed {st} at {t}.", "crossed": "has crossed {st}.",
    "departed_at": "has departed from {st} at {t}.", "departed": "has departed from {st}.",
    "arrived_at": "has arrived at {st} at {t}.", "arrived": "has arrived at {st}.",
    "reached_at": "has reached its destination {st} at {t}.", "reached": "has reached its destination {st}.",
    "yet": "is yet to start.",
    "km_to": "It is {km} from {st}.", "next": "The next station is {st}.",
    "halt": "Next halt {st}", "exp": "expected at {t}", "in_min": "in {n} minutes", "now": "arriving now",
    "on_time": "The train is running on time.", "late_m": "The train is running {n} minutes late.",
    "late_hm": "The train is running {h} hours {m} minutes late.",
    "time": "{h} hours {m} minutes", "time_h": "{h} hours", "time_at": "{h} hours {m} minutes", "time_h_at": "{h} hours",
    "km": "{v} kilometres", "km1": "1 kilometre", "point": "point",
    "appr": "is arriving at {st} {when}. Passengers are requested to be ready.",
    "appr_soon": "in about {n} minutes", "appr_now": "any moment now",
    "thanks": "Thank you.",
}

ANN = {
    "hi": {
        "intro": "यात्रीगण कृपया ध्यान दें।", "train": "गाड़ी संख्या {num}{name}",
        "crossed_at": "{t} {st} से गुज़र चुकी है।", "crossed": "{st} से गुज़र चुकी है।",
        "departed_at": "{t} {st} से रवाना हो चुकी है।", "departed": "{st} से रवाना हो चुकी है।",
        "arrived_at": "{t} {st} पहुँच चुकी है।", "arrived": "{st} पहुँच चुकी है।",
        "reached_at": "{t} अपने गंतव्य {st} पहुँच चुकी है।", "reached": "अपने गंतव्य {st} पहुँच चुकी है।",
        "yet": "अभी रवाना नहीं हुई है।",
        "km_to": "{st} यहाँ से {km} दूर है।", "next": "अगला स्टेशन {st} है।",
        "halt": "अगला ठहराव {st}", "exp": "अनुमानित समय {t}", "in_min": "{n} मिनट में", "now": "अभी पहुँच रही है",
        "on_time": "गाड़ी अपने निर्धारित समय पर चल रही है।", "late_m": "गाड़ी {n} मिनट की देरी से चल रही है।",
        "late_hm": "गाड़ी {h} घंटे {m} मिनट की देरी से चल रही है।",
        "time_at": "{h} बजकर {m} मिनट पर", "time_h_at": "{h} बजे",
        "time": "{h} बजकर {m} मिनट", "time_h": "{h} बजे",
        "km": "{v} किलोमीटर", "km1": "1 किलोमीटर", "point": "दशमलव",
        "appr": "{when} {st} पहुँचने वाली है। यात्रियों से अनुरोध है कि वे तैयार रहें।",
        "appr_soon": "लगभग {n} मिनट में", "appr_now": "किसी भी क्षण",
        "thanks": "धन्यवाद।",
    },
    "te": {
        "intro": "ప్రయాణికులకు విజ్ఞప్తి.", "train": "రైలు నంబర్ {num}{name}",
        "crossed_at": "{t} {st} దాటింది.", "crossed": "{st} దాటింది.",
        "departed_at": "{t} {st} నుండి బయలుదేరింది.", "departed": "{st} నుండి బయలుదేరింది.",
        "arrived_at": "{t} {st} చేరుకుంది.", "arrived": "{st} చేరుకుంది.",
        "reached_at": "{t} గమ్యస్థానం {st} చేరుకుంది.", "reached": "గమ్యస్థానం {st} చేరుకుంది.",
        "yet": "ఇంకా బయలుదేరలేదు.",
        "km_to": "{st} ఇక్కడి నుండి {km} దూరంలో ఉంది.", "next": "తదుపరి స్టేషన్ {st}.",
        "halt": "తదుపరి ఆగే స్టేషన్ {st}", "exp": "అంచనా సమయం {t}", "in_min": "{n} నిమిషాల్లో", "now": "ఇప్పుడే చేరుతోంది",
        "on_time": "రైలు సరైన సమయానికి నడుస్తోంది.", "late_m": "రైలు {n} నిమిషాలు ఆలస్యంగా నడుస్తోంది.",
        "late_hm": "రైలు {h} గంటల {m} నిమిషాలు ఆలస్యంగా నడుస్తోంది.",
        "time_at": "{h} గంటల {m} నిమిషాలకు", "time_h_at": "{h} గంటలకు",
        "time": "{h} గంటల {m} నిమిషాలు", "time_h": "{h} గంటలు",
        "km": "{v} కిలోమీటర్ల", "km1": "1 కిలోమీటరు", "point": "పాయింట్",
        "appr": "{when} {st} చేరుకోబోతోంది. ప్రయాణికులు సిద్ధంగా ఉండవలసిందిగా కోరుతున్నాము.",
        "appr_soon": "సుమారు {n} నిమిషాల్లో", "appr_now": "మరికొద్ది క్షణాల్లో",
        "thanks": "ధన్యవాదాలు.",
    },
    "ta": {
        "intro": "பயணிகளின் கனிவான கவனத்திற்கு.", "train": "ரயில் எண் {num}{name}",
        "crossed_at": "{t} {st} நிலையத்தைக் கடந்தது.", "crossed": "{st} நிலையத்தைக் கடந்தது.",
        "departed_at": "{t} {st} நிலையத்திலிருந்து புறப்பட்டது.", "departed": "{st} நிலையத்திலிருந்து புறப்பட்டது.",
        "arrived_at": "{t} {st} வந்தடைந்தது.", "arrived": "{st} வந்தடைந்தது.",
        "reached_at": "{t} சேருமிடமான {st} சென்றடைந்தது.", "reached": "சேருமிடமான {st} சென்றடைந்தது.",
        "yet": "இன்னும் புறப்படவில்லை.",
        "km_to": "{st} இங்கிருந்து {km} தொலைவில் உள்ளது.", "next": "அடுத்த நிலையம் {st}.",
        "halt": "அடுத்த நிறுத்தம் {st}", "exp": "எதிர்பார்க்கப்படும் நேரம் {t}", "in_min": "{n} நிமிடங்களில்", "now": "இப்போது வந்துகொண்டிருக்கிறது",
        "on_time": "ரயில் சரியான நேரத்தில் இயங்குகிறது.", "late_m": "ரயில் {n} நிமிடங்கள் தாமதமாக இயங்குகிறது.",
        "late_hm": "ரயில் {h} மணி {m} நிமிடங்கள் தாமதமாக இயங்குகிறது.",
        "time_at": "{h} மணி {m} நிமிடத்துக்கு", "time_h_at": "{h} மணிக்கு",
        "time": "{h} மணி {m} நிமிடம்", "time_h": "{h} மணி",
        "km": "{v} கிலோமீட்டர்", "km1": "1 கிலோமீட்டர்", "point": "புள்ளி",
        "appr": "{when} {st} வந்தடையும். பயணிகள் தயாராக இருக்கும்படி கேட்டுக்கொள்ளப்படுகிறார்கள்.",
        "appr_soon": "சுமார் {n} நிமிடங்களில்", "appr_now": "எந்த நேரத்திலும்",
        "thanks": "நன்றி.",
    },
    "kn": {
        "intro": "ಪ್ರಯಾಣಿಕರ ಗಮನಕ್ಕೆ.", "train": "ರೈಲು ಸಂಖ್ಯೆ {num}{name}",
        "crossed_at": "{t} {st} ದಾಟಿದೆ.", "crossed": "{st} ದಾಟಿದೆ.",
        "departed_at": "{t} {st} ಇಂದ ಹೊರಟಿದೆ.", "departed": "{st} ಇಂದ ಹೊರಟಿದೆ.",
        "arrived_at": "{t} {st} ತಲುಪಿದೆ.", "arrived": "{st} ತಲುಪಿದೆ.",
        "reached_at": "{t} ತನ್ನ ಗಮ್ಯಸ್ಥಾನ {st} ತಲುಪಿದೆ.", "reached": "ತನ್ನ ಗಮ್ಯಸ್ಥಾನ {st} ತಲುಪಿದೆ.",
        "yet": "ಇನ್ನೂ ಹೊರಟಿಲ್ಲ.",
        "km_to": "{st} ಇಲ್ಲಿಂದ {km} ದೂರದಲ್ಲಿದೆ.", "next": "ಮುಂದಿನ ನಿಲ್ದಾಣ {st}.",
        "halt": "ಮುಂದಿನ ನಿಲುಗಡೆ {st}", "exp": "ನಿರೀಕ್ಷಿತ ಸಮಯ {t}", "in_min": "{n} ನಿಮಿಷಗಳಲ್ಲಿ", "now": "ಈಗಲೇ ಬರುತ್ತಿದೆ",
        "on_time": "ರೈಲು ಸರಿಯಾದ ಸಮಯಕ್ಕೆ ಚಲಿಸುತ್ತಿದೆ.", "late_m": "ರೈಲು {n} ನಿಮಿಷ ತಡವಾಗಿ ಚಲಿಸುತ್ತಿದೆ.",
        "late_hm": "ರೈಲು {h} ಗಂಟೆ {m} ನಿಮಿಷ ತಡವಾಗಿ ಚಲಿಸುತ್ತಿದೆ.",
        "time_at": "{h} ಗಂಟೆ {m} ನಿಮಿಷಕ್ಕೆ", "time_h_at": "{h} ಗಂಟೆಗೆ",
        "time": "{h} ಗಂಟೆ {m} ನಿಮಿಷ", "time_h": "{h} ಗಂಟೆ",
        "km": "{v} ಕಿಲೋಮೀಟರ್", "km1": "1 ಕಿಲೋಮೀಟರ್", "point": "ಪಾಯಿಂಟ್",
        "appr": "{when} {st} ತಲುಪಲಿದೆ. ಪ್ರಯಾಣಿಕರು ಸಿದ್ಧರಾಗಿರಲು ಕೋರಲಾಗಿದೆ.",
        "appr_soon": "ಸುಮಾರು {n} ನಿಮಿಷಗಳಲ್ಲಿ", "appr_now": "ಯಾವುದೇ ಕ್ಷಣದಲ್ಲಿ",
        "thanks": "ಧನ್ಯವಾದಗಳು.",
    },
    "ml": {
        "intro": "യാത്രക്കാരുടെ ശ്രദ്ധയ്ക്ക്.", "train": "ട്രെയിൻ നമ്പർ {num}{name}",
        "crossed_at": "{t} {st} കടന്നു.", "crossed": "{st} കടന്നു.",
        "departed_at": "{t} {st} ൽ നിന്ന് പുറപ്പെട്ടു.", "departed": "{st} ൽ നിന്ന് പുറപ്പെട്ടു.",
        "arrived_at": "{t} {st} ൽ എത്തി.", "arrived": "{st} ൽ എത്തി.",
        "reached_at": "{t} ലക്ഷ്യസ്ഥാനമായ {st} ൽ എത്തി.", "reached": "ലക്ഷ്യസ്ഥാനമായ {st} ൽ എത്തി.",
        "yet": "ഇതുവരെ പുറപ്പെട്ടിട്ടില്ല.",
        "km_to": "{st} ഇവിടെ നിന്ന് {km} അകലെയാണ്.", "next": "അടുത്ത സ്റ്റേഷൻ {st}.",
        "halt": "അടുത്ത സ്റ്റോപ്പ് {st}", "exp": "പ്രതീക്ഷിക്കുന്ന സമയം {t}", "in_min": "{n} മിനിറ്റിനുള്ളിൽ", "now": "ഇപ്പോൾ എത്തുന്നു",
        "on_time": "ട്രെയിൻ കൃത്യസമയത്ത് ഓടുന്നു.", "late_m": "ട്രെയിൻ {n} മിനിറ്റ് വൈകി ഓടുന്നു.",
        "late_hm": "ട്രെയിൻ {h} മണിക്കൂർ {m} മിനിറ്റ് വൈകി ഓടുന്നു.",
        "time_at": "{h} മണി {m} മിനിറ്റിന്", "time_h_at": "{h} മണിക്ക്",
        "time": "{h} മണി {m} മിനിറ്റ്", "time_h": "{h} മണി",
        "km": "{v} കിലോമീറ്റർ", "km1": "1 കിലോമീറ്റർ", "point": "പോയിന്റ്",
        "appr": "{when} {st} ൽ എത്തിച്ചേരും. യാത്രക്കാർ തയ്യാറായിരിക്കാൻ അഭ്യർത്ഥിക്കുന്നു.",
        "appr_soon": "ഏകദേശം {n} മിനിറ്റിനുള്ളിൽ", "appr_now": "ഏത് നിമിഷവും",
        "thanks": "നന്ദി.",
    },
    "bn": {
        "intro": "যাত্রীদের দৃষ্টি আকর্ষণ করা হচ্ছে।", "train": "ট্রেন নম্বর {num}{name}",
        "crossed_at": "{t} {st} পার হয়েছে।", "crossed": "{st} পার হয়েছে।",
        "departed_at": "{t} {st} থেকে ছেড়েছে।", "departed": "{st} থেকে ছেড়েছে।",
        "arrived_at": "{t} {st} পৌঁছেছে।", "arrived": "{st} পৌঁছেছে।",
        "reached_at": "{t} গন্তব্য {st} পৌঁছেছে।", "reached": "গন্তব্য {st} পৌঁছেছে।",
        "yet": "এখনও ছাড়েনি।",
        "km_to": "{st} এখান থেকে {km} দূরে।", "next": "পরবর্তী স্টেশন {st}।",
        "halt": "পরবর্তী স্টপ {st}", "exp": "আনুমানিক সময় {t}", "in_min": "{n} মিনিটের মধ্যে", "now": "এখনই পৌঁছচ্ছে",
        "on_time": "ট্রেনটি সঠিক সময়ে চলছে।", "late_m": "ট্রেনটি {n} মিনিট দেরিতে চলছে।",
        "late_hm": "ট্রেনটি {h} ঘণ্টা {m} মিনিট দেরিতে চলছে।",
        "time_at": "{h}টা {m} মিনিটে", "time_h_at": "{h}টায়",
        "time": "{h}টা {m} মিনিট", "time_h": "{h}টা",
        "km": "{v} কিলোমিটার", "km1": "1 কিলোমিটার", "point": "দশমিক",
        "appr": "{when} {st} পৌঁছাবে। যাত্রীদের প্রস্তুত থাকার অনুরোধ করা হচ্ছে।",
        "appr_soon": "প্রায় {n} মিনিটের মধ্যে", "appr_now": "যে কোনো মুহূর্তে",
        "thanks": "ধন্যবাদ।",
    },
    "as": {
        "intro": "যাত্ৰীসকলৰ দৃষ্টি আকৰ্ষণ কৰা হৈছে।", "train": "ৰেল নম্বৰ {num}{name}",
        "crossed_at": "{t}ত {st} পাৰ হৈছে।", "crossed": "{st} পাৰ হৈছে।",
        "departed_at": "{t}ত {st}ৰ পৰা যাত্ৰা আৰম্ভ কৰিছে।", "departed": "{st}ৰ পৰা যাত্ৰা আৰম্ভ কৰিছে।",
        "arrived_at": "{t}ত {st} পাইছে।", "arrived": "{st} পাইছে।",
        "reached_at": "{t}ত গন্তব্যস্থান {st} পাইছে।", "reached": "গন্তব্যস্থান {st} পাইছে।",
        "yet": "এতিয়াও যাত্ৰা আৰম্ভ কৰা নাই।",
        "km_to": "{st} ইয়াৰ পৰা {km} দূৰত।", "next": "পৰৱৰ্তী ষ্টেচন {st}।",
        "halt": "পৰৱৰ্তী ৰখা ষ্টেচন {st}", "exp": "আনুমানিক সময় {t}", "in_min": "{n} মিনিটৰ ভিতৰত", "now": "এতিয়াই আহি আছে",
        "on_time": "ৰেলখন সঠিক সময়ত চলি আছে।", "late_m": "ৰেলখন {n} মিনিট পলমকৈ চলি আছে।",
        "late_hm": "ৰেলখন {h} ঘণ্টা {m} মিনিট পলমকৈ চলি আছে।",
        "time": "{h} বাজি {m} মিনিট", "time_h": "{h} বাজি",
        "km": "{v} কিলোমিটাৰ", "km1": "1 কিলোমিটাৰ", "point": "দশমিক",
        "appr": "{when} {st} পাব। যাত্ৰীসকলক সাজু থাকিবলৈ অনুৰোধ কৰা হৈছে।",
        "appr_soon": "প্ৰায় {n} মিনিটৰ ভিতৰত", "appr_now": "যিকোনো মুহূৰ্তত",
        "thanks": "ধন্যবাদ।",
    },
    "mr": {
        "intro": "प्रवाशांनी कृपया लक्ष द्यावे.", "train": "गाडी क्रमांक {num}{name}",
        "crossed_at": "{t} {st} ओलांडले आहे.", "crossed": "{st} ओलांडले आहे.",
        "departed_at": "{t} {st} येथून सुटली आहे.", "departed": "{st} येथून सुटली आहे.",
        "arrived_at": "{t} {st} येथे पोहोचली आहे.", "arrived": "{st} येथे पोहोचली आहे.",
        "reached_at": "{t} आपल्या अंतिम स्थानक {st} येथे पोहोचली आहे.", "reached": "आपल्या अंतिम स्थानक {st} येथे पोहोचली आहे.",
        "yet": "अद्याप सुटलेली नाही.",
        "km_to": "{st} येथून {km} अंतरावर आहे.", "next": "पुढील स्थानक {st}.",
        "halt": "पुढील थांबा {st}", "exp": "अपेक्षित वेळ {t}", "in_min": "{n} मिनिटांत", "now": "आता पोहोचत आहे",
        "on_time": "गाडी वेळेवर धावत आहे.", "late_m": "गाडी {n} मिनिटे उशिराने धावत आहे.",
        "late_hm": "गाडी {h} तास {m} मिनिटे उशिराने धावत आहे.",
        "time_at": "{h} वाजून {m} मिनिटांनी", "time_h_at": "{h} वाजता",
        "time": "{h} वाजून {m} मिनिटे", "time_h": "{h} वाजता",
        "km": "{v} किलोमीटर", "km1": "1 किलोमीटर", "point": "पूर्णांक",
        "appr": "{when} {st} येथे पोहोचेल. प्रवाशांनी तयार राहावे ही विनंती.",
        "appr_soon": "सुमारे {n} मिनिटांत", "appr_now": "कोणत्याही क्षणी",
        "thanks": "धन्यवाद.",
    },
    "gu": {
        "intro": "મુસાફરો કૃપયા ધ્યાન આપે.", "train": "ટ્રેન નંબર {num}{name}",
        "crossed_at": "{t} {st} પસાર કર્યું છે.", "crossed": "{st} પસાર કર્યું છે.",
        "departed_at": "{t} {st} થી ઉપડી છે.", "departed": "{st} થી ઉપડી છે.",
        "arrived_at": "{t} {st} પહોંચી છે.", "arrived": "{st} પહોંચી છે.",
        "reached_at": "{t} પોતાના અંતિમ સ્ટેશન {st} પહોંચી છે.", "reached": "પોતાના અંતિમ સ્ટેશન {st} પહોંચી છે.",
        "yet": "હજી ઉપડી નથી.",
        "km_to": "{st} અહીંથી {km} દૂર છે.", "next": "આગામી સ્ટેશન {st}.",
        "halt": "આગામી સ્ટોપ {st}", "exp": "અપેક્ષિત સમય {t}", "in_min": "{n} મિનિટમાં", "now": "હમણાં પહોંચી રહી છે",
        "on_time": "ટ્રેન સમયસર દોડી રહી છે.", "late_m": "ટ્રેન {n} મિનિટ મોડી દોડી રહી છે.",
        "late_hm": "ટ્રેન {h} કલાક {m} મિનિટ મોડી દોડી રહી છે.",
        "time_at": "{h} વાગીને {m} મિનિટે", "time_h_at": "{h} વાગ્યે",
        "time": "{h} વાગીને {m} મિનિટ", "time_h": "{h} વાગ્યે",
        "km": "{v} કિલોમીટર", "km1": "1 કિલોમીટર", "point": "દશાંશ",
        "appr": "{when} {st} પહોંચશે. મુસાફરોને તૈયાર રહેવા વિનંતી.",
        "appr_soon": "લગભગ {n} મિનિટમાં", "appr_now": "કોઈપણ ક્ષણે",
        "thanks": "આભાર.",
    },
    "pa": {
        "intro": "ਯਾਤਰੀ ਕਿਰਪਾ ਕਰਕੇ ਧਿਆਨ ਦੇਣ।", "train": "ਗੱਡੀ ਨੰਬਰ {num}{name}",
        "crossed_at": "{t} {st} ਤੋਂ ਲੰਘ ਚੁੱਕੀ ਹੈ।", "crossed": "{st} ਤੋਂ ਲੰਘ ਚੁੱਕੀ ਹੈ।",
        "departed_at": "{t} {st} ਤੋਂ ਰਵਾਨਾ ਹੋ ਚੁੱਕੀ ਹੈ।", "departed": "{st} ਤੋਂ ਰਵਾਨਾ ਹੋ ਚੁੱਕੀ ਹੈ।",
        "arrived_at": "{t} {st} ਪਹੁੰਚ ਚੁੱਕੀ ਹੈ।", "arrived": "{st} ਪਹੁੰਚ ਚੁੱਕੀ ਹੈ।",
        "reached_at": "{t} ਆਪਣੀ ਮੰਜ਼ਿਲ {st} ਪਹੁੰਚ ਚੁੱਕੀ ਹੈ।", "reached": "ਆਪਣੀ ਮੰਜ਼ਿਲ {st} ਪਹੁੰਚ ਚੁੱਕੀ ਹੈ।",
        "yet": "ਹਾਲੇ ਰਵਾਨਾ ਨਹੀਂ ਹੋਈ।",
        "km_to": "{st} ਇੱਥੋਂ {km} ਦੂਰ ਹੈ।", "next": "ਅਗਲਾ ਸਟੇਸ਼ਨ {st} ਹੈ।",
        "halt": "ਅਗਲਾ ਠਹਿਰਾਅ {st}", "exp": "ਅੰਦਾਜ਼ਨ ਸਮਾਂ {t}", "in_min": "{n} ਮਿੰਟ ਵਿੱਚ", "now": "ਹੁਣੇ ਪਹੁੰਚ ਰਹੀ ਹੈ",
        "on_time": "ਗੱਡੀ ਸਮੇਂ ਸਿਰ ਚੱਲ ਰਹੀ ਹੈ।", "late_m": "ਗੱਡੀ {n} ਮਿੰਟ ਦੇਰੀ ਨਾਲ ਚੱਲ ਰਹੀ ਹੈ।",
        "late_hm": "ਗੱਡੀ {h} ਘੰਟੇ {m} ਮਿੰਟ ਦੇਰੀ ਨਾਲ ਚੱਲ ਰਹੀ ਹੈ।",
        "time_at": "{h} ਵੱਜ ਕੇ {m} ਮਿੰਟ 'ਤੇ", "time_h_at": "{h} ਵਜੇ",
        "time": "{h} ਵੱਜ ਕੇ {m} ਮਿੰਟ", "time_h": "{h} ਵਜੇ",
        "km": "{v} ਕਿਲੋਮੀਟਰ", "km1": "1 ਕਿਲੋਮੀਟਰ", "point": "ਦਸ਼ਮਲਵ",
        "appr": "{when} {st} ਪਹੁੰਚਣ ਵਾਲੀ ਹੈ। ਯਾਤਰੀਆਂ ਨੂੰ ਤਿਆਰ ਰਹਿਣ ਦੀ ਬੇਨਤੀ ਹੈ।",
        "appr_soon": "ਲਗਭਗ {n} ਮਿੰਟ ਵਿੱਚ", "appr_now": "ਕਿਸੇ ਵੀ ਪਲ",
        "thanks": "ਧੰਨਵਾਦ।",
    },
    "or": {
        "intro": "ଯାତ୍ରୀମାନଙ୍କ ଦୃଷ୍ଟି ଆକର୍ଷଣ କରାଯାଉଛି।", "train": "ଟ୍ରେନ ନମ୍ବର {num}{name}",
        "crossed_at": "{t}ରେ {st} ଅତିକ୍ରମ କରିଛି।", "crossed": "{st} ଅତିକ୍ରମ କରିଛି।",
        "departed_at": "{t}ରେ {st}ରୁ ଛାଡିଛି।", "departed": "{st}ରୁ ଛାଡିଛି।",
        "arrived_at": "{t}ରେ {st}ରେ ପହଞ୍ଚିଛି।", "arrived": "{st}ରେ ପହଞ୍ଚିଛି।",
        "reached_at": "{t}ରେ ଗନ୍ତବ୍ୟସ୍ଥଳ {st}ରେ ପହଞ୍ଚିଛି।", "reached": "ଗନ୍ତବ୍ୟସ୍ଥଳ {st}ରେ ପହଞ୍ଚିଛି।",
        "yet": "ଏପର୍ଯ୍ୟନ୍ତ ଛାଡିନାହିଁ।",
        "km_to": "{st} ଏଠାରୁ {km} ଦୂରରେ ଅଛି।", "next": "ପରବର୍ତ୍ତୀ ଷ୍ଟେସନ {st}।",
        "halt": "ପରବର୍ତ୍ତୀ ଷ୍ଟପ୍ {st}", "exp": "ଆନୁମାନିକ ସମୟ {t}", "in_min": "{n} ମିନିଟରେ", "now": "ଏବେ ପହଞ୍ଚୁଛି",
        "on_time": "ଟ୍ରେନଟି ଠିକ୍ ସମୟରେ ଚାଲୁଛି।", "late_m": "ଟ୍ରେନଟି {n} ମିନିଟ୍ ବିଳମ୍ବରେ ଚାଲୁଛି।",
        "late_hm": "ଟ୍ରେନଟି {h} ଘଣ୍ଟା {m} ମିନିଟ୍ ବିଳମ୍ବରେ ଚାଲୁଛି।",
        "time": "{h}ଟା {m} ମିନିଟ", "time_h": "{h}ଟା",
        "km": "{v} କିଲୋମିଟର", "km1": "1 କିଲୋମିଟର", "point": "ଦଶମିକ",
        "appr": "{when} {st}ରେ ପହଞ୍ଚିବ। ଯାତ୍ରୀମାନଙ୍କୁ ପ୍ରସ୍ତୁତ ରହିବାକୁ ଅନୁରୋଧ।",
        "appr_soon": "ପ୍ରାୟ {n} ମିନିଟରେ", "appr_now": "ଯେକୌଣସି ମୁହୂର୍ତ୍ତରେ",
        "thanks": "ଧନ୍ୟବାଦ।",
    },
    "ur": {
        "intro": "مسافر حضرات توجہ فرمائیں۔", "train": "گاڑی نمبر {num}{name}",
        "crossed_at": "{t} {st} سے گزر چکی ہے۔", "crossed": "{st} سے گزر چکی ہے۔",
        "departed_at": "{t} {st} سے روانہ ہو چکی ہے۔", "departed": "{st} سے روانہ ہو چکی ہے۔",
        "arrived_at": "{t} {st} پہنچ چکی ہے۔", "arrived": "{st} پہنچ چکی ہے۔",
        "reached_at": "{t} اپنی منزل {st} پہنچ چکی ہے۔", "reached": "اپنی منزل {st} پہنچ چکی ہے۔",
        "yet": "ابھی روانہ نہیں ہوئی۔",
        "km_to": "{st} یہاں سے {km} دور ہے۔", "next": "اگلا اسٹیشن {st} ہے۔",
        "halt": "اگلا اسٹاپ {st}", "exp": "متوقع وقت {t}", "in_min": "{n} منٹ میں", "now": "ابھی پہنچ رہی ہے",
        "on_time": "گاڑی اپنے مقررہ وقت پر چل رہی ہے۔", "late_m": "گاڑی {n} منٹ کی تاخیر سے چل رہی ہے۔",
        "late_hm": "گاڑی {h} گھنٹے {m} منٹ کی تاخیر سے چل رہی ہے۔",
        "time_at": "{h} بج کر {m} منٹ پر", "time_h_at": "{h} بجے",
        "time": "{h} بج کر {m} منٹ", "time_h": "{h} بجے",
        "km": "{v} کلومیٹر", "km1": "1 کلومیٹر", "point": "اعشاریہ",
        "appr": "{when} {st} پہنچنے والی ہے۔ مسافروں سے گزارش ہے کہ تیار رہیں۔",
        "appr_soon": "تقریباً {n} منٹ میں", "appr_now": "کسی بھی لمحے",
        "thanks": "شکریہ۔",
    },
    "ne": {
        "intro": "यात्रुहरूको ध्यानाकर्षण गराइन्छ।", "train": "रेल नम्बर {num}{name}",
        "crossed_at": "{t} {st} पार गरिसकेको छ।", "crossed": "{st} पार गरिसकेको छ।",
        "departed_at": "{t} {st} बाट छुटिसकेको छ।", "departed": "{st} बाट छुटिसकेको छ।",
        "arrived_at": "{t} {st} आइपुगेको छ।", "arrived": "{st} आइपुगेको छ।",
        "reached_at": "{t} गन्तव्य {st} पुगेको छ।", "reached": "गन्तव्य {st} पुगेको छ।",
        "yet": "अझै छुटेको छैन।",
        "km_to": "{st} यहाँबाट {km} टाढा छ।", "next": "अर्को स्टेसन {st} हो।",
        "halt": "अर्को रोकाइ {st}", "exp": "अनुमानित समय {t}", "in_min": "{n} मिनेटमा", "now": "अहिले आइपुग्दैछ",
        "on_time": "रेल समयमै चलिरहेको छ।", "late_m": "रेल {n} मिनेट ढिला चलिरहेको छ।",
        "late_hm": "रेल {h} घण्टा {m} मिनेट ढिला चलिरहेको छ।",
        "time_at": "{h} बजेर {m} मिनेटमा", "time_h_at": "{h} बजे",
        "time": "{h} बजेर {m} मिनेट", "time_h": "{h} बजे",
        "km": "{v} किलोमिटर", "km1": "1 किलोमिटर", "point": "दशमलव",
        "appr": "{when} {st} आइपुग्नेछ। यात्रुहरूलाई तयार रहन अनुरोध छ।",
        "appr_soon": "करिब {n} मिनेटमा", "appr_now": "जुनसुकै बेला",
        "thanks": "धन्यवाद।",
    },
    "kok": {
        "intro": "प्रवाशांनी उपकार करून लक्ष दिवचें.", "train": "गाडी क्रमांक {num}{name}",
        "crossed_at": "{t} {st} पार केलां.", "crossed": "{st} पार केलां.",
        "departed_at": "{t} {st} सुटल्या.", "departed": "{st} सुटल्या.",
        "arrived_at": "{t} {st} पावल्या.", "arrived": "{st} पावल्या.",
        "reached_at": "{t} निमाणें स्टेशन {st} पावल्या.", "reached": "निमाणें स्टेशन {st} पावल्या.",
        "yet": "अजून सुटूंक ना.",
        "km_to": "{st} हांगाच्यान {km} पयस आसा.", "next": "फुडलें स्टेशन {st}.",
        "halt": "फुडलो थांबो {st}", "exp": "अपेक्षीत वेळ {t}", "in_min": "{n} मिणटांनी", "now": "आतां पावता",
        "on_time": "गाडी वेळार धांवता.", "late_m": "गाडी {n} मिणटां उशिरान धांवता.",
        "late_hm": "गाडी {h} वरां {m} मिणटां उशिरान धांवता.",
        "time_at": "{h} वरां {m} मिणटांनी", "time_h_at": "{h} वरां",
        "time": "{h} वरां {m} मिणटां", "time_h": "{h} वरां",
        "km": "{v} किलोमीटर", "km1": "1 किलोमीटर", "point": "पूर्णांक",
        "appr": "{when} {st} पावतली. प्रवाशांनी तयार रावचें.",
        "appr_soon": "सुमार {n} मिणटांनी", "appr_now": "खंयच्याय खिणाक",
        "thanks": "देव बरें करूं.",
    },
    "mai": {
        "intro": "यात्रीगण कृपया ध्यान दिअ।", "train": "गाड़ी संख्या {num}{name}",
        "crossed_at": "{t} {st} पार क' गेल अछि।", "crossed": "{st} पार क' गेल अछि।",
        "departed_at": "{t} {st} सँ खुजि गेल अछि।", "departed": "{st} सँ खुजि गेल अछि।",
        "arrived_at": "{t} {st} पहुँचि गेल अछि।", "arrived": "{st} पहुँचि गेल अछि।",
        "reached_at": "{t} अपन गंतव्य {st} पहुँचि गेल अछि।", "reached": "अपन गंतव्य {st} पहुँचि गेल अछि।",
        "yet": "एखन धरि नहि खुजल अछि।",
        "km_to": "{st} एतय सँ {km} दूर अछि।", "next": "अगिला स्टेशन {st} अछि।",
        "halt": "अगिला ठहराव {st}", "exp": "अनुमानित समय {t}", "in_min": "{n} मिनटमे", "now": "एखने पहुँचि रहल अछि",
        "on_time": "गाड़ी समय पर चलि रहल अछि।", "late_m": "गाड़ी {n} मिनट देरी सँ चलि रहल अछि।",
        "late_hm": "गाड़ी {h} घंटा {m} मिनट देरी सँ चलि रहल अछि।",
        "time_at": "{h} बाजि क' {m} मिनट पर", "time_h_at": "{h} बजे",
        "time": "{h} बाजि क' {m} मिनट", "time_h": "{h} बजे",
        "km": "{v} किलोमीटर", "km1": "1 किलोमीटर", "point": "दशमलव",
        "appr": "{when} {st} पहुँचय बला अछि। यात्री लोकनि तैयार रहू।",
        "appr_soon": "लगभग {n} मिनटमे", "appr_now": "कोनो क्षण",
        "thanks": "धन्यवाद।",
    },
    "doi": {
        "intro": "यात्री ध्यान देओ।", "train": "गड्डी नंबर {num}{name}",
        "crossed_at": "{t} {st} पार करी चुकी ऐ।", "crossed": "{st} पार करी चुकी ऐ।",
        "departed_at": "{t} {st} थमां चली चुकी ऐ।", "departed": "{st} थमां चली चुकी ऐ।",
        "arrived_at": "{t} {st} पुज्जी चुकी ऐ।", "arrived": "{st} पुज्जी चुकी ऐ।",
        "reached_at": "{t} अपनी मंजल {st} पुज्जी चुकी ऐ।", "reached": "अपनी मंजल {st} पुज्जी चुकी ऐ।",
        "yet": "अजें नेईं चली।",
        "km_to": "{st} इत्थुआं {km} दूर ऐ।", "next": "अगला स्टेशन {st} ऐ।",
        "halt": "अगला ठैहराऽ {st}", "exp": "अंदाजन समां {t}", "in_min": "{n} मिंटें च", "now": "हुनै पुज्जा दी ऐ",
        "on_time": "गड्डी समें पर चला दी ऐ।", "late_m": "गड्डी {n} मिंट देरी कन्नै चला दी ऐ।",
        "late_hm": "गड्डी {h} घैंटे {m} मिंट देरी कन्नै चला दी ऐ।",
        "time_at": "{h} बजियै {m} मिंटें पर", "time_h_at": "{h} बजे",
        "time": "{h} बजियै {m} मिंट", "time_h": "{h} बजे",
        "km": "{v} किलोमीटर", "km1": "1 किलोमीटर", "point": "दशमलव",
        "appr": "{when} {st} पुज्जने आह्ली ऐ। यात्री त्यार रौह्न।",
        "appr_soon": "लगभग {n} मिंटें च", "appr_now": "कुसै बी पल",
        "thanks": "धन्नवाद।",
    },
    "brx": {
        "intro": "सफरगिरिफोरा अननानै मोनोथि हो।", "train": "रेलगाड़ि नम्बर {num}{name}",
        "crossed_at": "{t} आव {st} खौ गाबखां नांबाय।", "crossed": "{st} खौ गाबखां नांबाय।",
        "departed_at": "{t} आव {st} निफ्राय थांनाय।", "departed": "{st} निफ्राय थांनाय।",
        "arrived_at": "{t} आव {st} आव सौहैनाय।", "arrived": "{st} आव सौहैनाय।",
        "reached_at": "{t} आव जोबथा थाव {st} आव सौहैनाय।", "reached": "जोबथा थाव {st} आव सौहैनाय।",
        "yet": "दासिम थांखांखै।",
        "km_to": "{st} बेनि निफ्राय {km} गोजान।", "next": "उननि स्टेशन {st}।",
        "halt": "उननि थाबथि {st}", "exp": "सानखांनाय सम {t}", "in_min": "{n} मिनिटआव", "now": "दा सौहैगासिनो दं",
        "on_time": "रेलगाड़िआ समाव थांगासिनो दं।", "late_m": "रेलगाड़िआ {n} मिनिट गोजान थांगासिनो दं।",
        "late_hm": "रेलगाड़िआ {h} घन्टा {m} मिनिट गोजान थांगासिनो दं।",
        "time": "{h} बाजि {m} मिनिट", "time_h": "{h} बाजि",
        "km": "{v} किलोमिटार", "km1": "1 किलोमिटार", "point": "दशमलव",
        "appr": "{when} {st} आव सौहैगोन। सफरगिरिफोरा थियारि जा।",
        "appr_soon": "मोनसे {n} मिनिटआव", "appr_now": "जायखिजाया समाव",
        "thanks": "सावराय।",
    },
    "sa": {
        "intro": "यात्रिणः कृपया ध्यानं ददतु।", "train": "रेलयानसंख्या {num}{name}",
        "crossed_at": "{t} {st} अतिक्रान्तवत्।", "crossed": "{st} अतिक्रान्तवत्।",
        "departed_at": "{t} {st} तः प्रस्थितम्।", "departed": "{st} तः प्रस्थितम्।",
        "arrived_at": "{t} {st} प्राप्तम्।", "arrived": "{st} प्राप्तम्।",
        "reached_at": "{t} गन्तव्यं {st} प्राप्तम्।", "reached": "गन्तव्यं {st} प्राप्तम्।",
        "yet": "अद्यापि न प्रस्थितम्।",
        "km_to": "{st} इतः {km} दूरे अस्ति।", "next": "अग्रिमं स्थानकं {st}।",
        "halt": "अग्रिमः विरामः {st}", "exp": "अपेक्षितः समयः {t}", "in_min": "{n} निमेषेषु", "now": "इदानीम् आगच्छति",
        "on_time": "रेलयानं समये चलति।", "late_m": "रेलयानं {n} निमेषान् विलम्बेन चलति।",
        "late_hm": "रेलयानं {h} होराः {m} निमेषान् विलम्बेन चलति।",
        "time_at": "{h} वादित्वा {m} निमेषे", "time_h_at": "{h} वादने",
        "time": "{h} वादित्वा {m} निमेषाः", "time_h": "{h} वादने",
        "km": "{v} किलोमीटर", "km1": "1 किलोमीटर", "point": "दशमलव",
        "appr": "{when} {st} प्राप्स्यति। यात्रिणः सज्जाः भवन्तु।",
        "appr_soon": "प्रायः {n} निमेषेषु", "appr_now": "कस्मिन्नपि क्षणे",
        "thanks": "धन्यवादः।",
    },
    "sat": {
        "intro": "सफरियको धेयान एमपे।", "train": "रेलगाड़ी नम्बर {num}{name}",
        "crossed_at": "{t} रे {st} पार एना।", "crossed": "{st} पार एना।",
        "departed_at": "{t} रे {st} खोन सेनोजोना।", "departed": "{st} खोन सेनोजोना।",
        "arrived_at": "{t} रे {st} सेटेर एना।", "arrived": "{st} सेटेर एना।",
        "reached_at": "{t} रे मुचाद ठाँव {st} सेटेर एना।", "reached": "मुचाद ठाँव {st} सेटेर एना।",
        "yet": "नितोक हों बाय सेनोजोना।",
        "km_to": "{st} नोंडे खोन {km} सांगिन रे।", "next": "तायोम स्टेशन {st}।",
        "halt": "तायोम तिंगु ठाँव {st}", "exp": "आंदाज ओकते {t}", "in_min": "{n} मिनिट रे", "now": "नितगे सेटेरोक कान",
        "on_time": "रेलगाड़ी ओकते रे चालाक कान।", "late_m": "रेलगाड़ी {n} मिनिट देरी ते चालाक कान।",
        "late_hm": "रेलगाड़ी {h} घंटा {m} मिनिट देरी ते चालाक कान।",
        "time": "{h} बाजे {m} मिनिट", "time_h": "{h} बाजे",
        "km": "{v} किलोमीटर", "km1": "1 किलोमीटर", "point": "दशमलव",
        "appr": "{when} {st} सेटेरोक आ। सफरियको तियार ताहें पे।",
        "appr_soon": "लगभग {n} मिनिट रे", "appr_now": "जाहान ओकते",
        "thanks": "सारहाव।",
    },
    "sd": {
        "intro": "مسافرن کي ڌيان ڏيڻ جي گذارش آهي.", "train": "ٽرين نمبر {num}{name}",
        "crossed_at": "{t} تي {st} پار ڪري چڪي آهي.", "crossed": "{st} پار ڪري چڪي آهي.",
        "departed_at": "{t} تي {st} کان روانو ٿي چڪي آهي.", "departed": "{st} کان روانو ٿي چڪي آهي.",
        "arrived_at": "{t} تي {st} پهچي چڪي آهي.", "arrived": "{st} پهچي چڪي آهي.",
        "reached_at": "{t} تي پنهنجي منزل {st} پهچي چڪي آهي.", "reached": "پنهنجي منزل {st} پهچي چڪي آهي.",
        "yet": "اڃا روانو نه ٿي آهي.",
        "km_to": "{st} هتان {km} پري آهي.", "next": "ايندڙ اسٽيشن {st} آهي.",
        "halt": "اڳيون اسٽاپ {st}", "exp": "متوقع وقت {t}", "in_min": "{n} منٽن ۾", "now": "هاڻي پهچي رهي آهي",
        "on_time": "ٽرين وقت تي هلي رهي آهي.", "late_m": "ٽرين {n} منٽ دير سان هلي رهي آهي.",
        "late_hm": "ٽرين {h} ڪلاڪ {m} منٽ دير سان هلي رهي آهي.",
        "time": "{h} وڳي {m} منٽ", "time_h": "{h} وڳي",
        "km": "{v} ڪلوميٽر", "km1": "1 ڪلوميٽر", "point": "اعشاريه",
        "appr": "{when} {st} پهچڻ واري آهي. مسافر تيار رهن.",
        "appr_soon": "لڳ ڀڳ {n} منٽن ۾", "appr_now": "ڪنهن به گهڙي",
        "thanks": "مهرباني.",
    },
    "ks": {
        "intro": "مسافرو، مہربٲنی کٔرِتھ دِیِو توجہ۔", "train": "ریل نمبر {num}{name}",
        "crossed_at": "{t} {st} کوٚر پار۔", "crossed": "{st} کوٚر پار۔",
        "departed_at": "{t} {st} پیٚٹھہٕ دراو۔", "departed": "{st} پیٚٹھہٕ دراو۔",
        "arrived_at": "{t} {st} واتیٚو۔", "arrived": "{st} واتیٚو۔",
        "reached_at": "{t} پننِس منزلس {st} واتیٚو۔", "reached": "پننِس منزلس {st} واتیٚو۔",
        "yet": "ووٚنی چھےٚ نہٕ دراو۔",
        "km_to": "{st} چھُ یتہِ {km} دور۔", "next": "بییہ سٹیشن {st}۔",
        "halt": "بییہ ٹھہراو {st}", "exp": "متوقع وقت {t}", "in_min": "{n} منٹن منٛز", "now": "وۄنۍ چھےٚ واتان",
        "on_time": "ریل چھےٚ وقتس پیٚٹھ پکان۔", "late_m": "ریل چھےٚ {n} منٹ دیر پکان۔",
        "late_hm": "ریل چھےٚ {h} گھنٹہٕ {m} منٹ دیر پکان۔",
        "time_at": "{h} بجہ {m} منٹس پیٹھ", "time_h_at": "{h} بجہ",
        "time": "{h} بجہ {m} منٹ", "time_h": "{h} بجہ",
        "km": "{v} کلومیٹر", "km1": "1 کلومیٹر", "point": "اعشاریہ",
        "appr": "{when} {st} واتہِ۔ مسافر روزِن تیار۔",
        "appr_soon": "تقریباً {n} منٹن منٛز", "appr_now": "کُنہِ تہِ وِزِ",
        "thanks": "شکریہ۔",
    },
    "mni": {
        "intro": "খোংচৎ তৌবশিংগী মীওইশিংনা মিৎয়েং থম্বিয়ু।", "train": "ট্রেন নম্বর {num}{name}",
        "crossed_at": "{t}দা {st} চৎলে।", "crossed": "{st} চৎলে।",
        "departed_at": "{t}দা {st}দগী হৌরে।", "departed": "{st}দগী হৌরে।",
        "arrived_at": "{t}দা {st} য়ৌরে।", "arrived": "{st} য়ৌরে।",
        "reached_at": "{t}দা লোইশিনফম {st} য়ৌরে।", "reached": "লোইশিনফম {st} য়ৌরে।",
        "yet": "হৌদ্রিঙেই।",
        "km_to": "{st} মসিদগী {km} লাপ্পদা লৈ।", "next": "মথংগী স্টেসন {st}।",
        "halt": "মথংগী লেপ্পা মফম {st}", "exp": "থাজবা মতম {t}", "in_min": "মিনিট {n}দা", "now": "হৌজিক য়ৌরিবনি",
        "on_time": "ট্রেন অসি মতম চানা চৎলি।", "late_m": "ট্রেন অসি মিনিট {n} শোত্থনা চৎলি।",
        "late_hm": "ট্রেন অসি পুং {h} মিনিট {m} শোত্থনা চৎলি।",
        "time": "পুং {h} মিনিট {m}", "time_h": "পুং {h}",
        "km": "কিলোমিটার {v}", "km1": "কিলোমিটার 1", "point": "পোইন্ট",
        "appr": "{when} {st} য়ৌগনি। খোংচৎ তৌবশিংনা শেমশাদুনা লৈবিয়ু।",
        "appr_soon": "মিনিট {n}দা", "appr_now": "কদায়দা য়ৌরবসু",
        "thanks": "থাগৎচরি।",
    },
}


_STOP = {"hi": "।", "bn": "।", "as": "।", "pa": "।", "ne": "।", "mai": "।", "doi": "।", "brx": "।",
         "sa": "।", "sat": "।", "or": "।", "mni": "।", "ur": "۔", "ks": "۔"}


def ann(lang: str, key: str, **kw) -> str:
    table = ANN.get(lang) or EN_ANN
    tpl = table.get(key) or EN_ANN[key]
    try:
        return tpl.format(**kw)
    except (KeyError, IndexError):
        return EN_ANN[key].format(**kw)


# ---------------------------------------------------------------------------
# Numbers, times, distances — spelled so the voice reads them correctly.
# ---------------------------------------------------------------------------
def spoken_number(v, lang: str) -> str:
    """8.3 -> "8 point 3" (in `lang`); 12 -> "12"; 0.25 -> "0 point 2 5"."""
    try:
        f = float(v)
    except (TypeError, ValueError):
        return str(v)
    s = f"{f:g}"
    if "e" in s:
        s = f"{f:.1f}"
    if "." not in s:
        return s
    whole, frac = s.split(".", 1)
    return f"{whole} {ann(lang, 'point')} {' '.join(frac)}"


def spoken_km(v, lang: str) -> str:
    try:
        if float(v) == 1:
            return ann(lang, "km1")
    except (TypeError, ValueError):
        pass
    return ann(lang, "km", v=spoken_number(v, lang))


def spoken_time(hhmm: Optional[str], lang: str, at: bool = False) -> str:
    """'17:05' -> '17 hours 5 minutes' (announcers use the 24-hour clock).
    at=True: the "at 17:05" form ("17 बजकर 5 मिनट पर")."""
    m = re.match(r"^\s*(\d{1,2}):(\d{2})", str(hhmm or ""))
    if not m:
        return str(hhmm or "")
    h, mi = int(m.group(1)), int(m.group(2))
    table = ANN.get(lang) or EN_ANN
    key = ("time_h" if mi == 0 else "time") + ("_at" if at and ("time_at" in table) else "")
    return ann(lang, key, h=h, m=mi)


def spoken_train_number(num) -> str:
    """'12797' -> '1 2 7 9 7' (read digit by digit, like at the station)."""
    return " ".join(ch for ch in str(num or "") if ch.isdigit()) or str(num or "")


# ---------------------------------------------------------------------------
# Station / village names in the language's own script.
# ---------------------------------------------------------------------------
# Scheme used below (and for STATION_SAY): doubled vowels are long
# ("aa" = आ, "ii"/"ee" = ई, "uu"/"oo" = ऊ), "e"/"o" = ए/ओ, "ai"/"au" = ऐ/औ,
# h after k g c j t d p b = aspirate, "T"/"D"/"N"/"L" (capital) = retroflex,
# "sh" = श, "Sh" = ष, "zh" = ழ/ഴ.
STATION_SAY = {
    # Curated pronunciations of names whose English spelling misleads a
    # rule-based reader. Key: lower-case name as the railway writes it.
    "rajahmundry": "raajamanDrii", "vijayawada": "vijayavaaDaa", "secunderabad": "sikandaraabaad",
    "hyderabad": "haidaraabaad", "hyderabad decan": "haidaraabaad deccan", "kacheguda": "kaachEguuDaa",
    "visakhapatnam": "vishaakhapaTTaNam", "vishakhapatnam": "vishaakhapaTTaNam", "eluru": "Eluuru",
    "tadepalligudem": "taaDEpalliguuDem", "nidadavolu": "niDaDavoolu", "samalkot": "saamarlakoTa",
    "samalkot jn": "saamarlakoTa jankshan", "tuni": "tuni", "anakapalle": "anakaapalli",
    "guntur": "gunTuur", "nellore": "nelluuru", "tirupati": "tirupati", "renigunta": "rENiguNTa",
    "gudur": "guuDuur", "ongole": "ongOlu", "warangal": "varangal", "kazipet": "kaaziipeeT",
    "khammam": "khammam", "mahbubabad": "mahabuubaabaad", "kurnool": "karnuul", "anantapur": "anantapuram",
    "guntakal": "gunTakal", "dharmavaram": "dharmavaram", "kadapa": "kaDapa", "cuddapah": "kaDapa",
    "chennai": "chennai", "chennai central": "chennai senTral", "chennai egmore": "chennai egmOr",
    "madurai": "madurai", "tiruchchirappalli": "tiruchiraappalli", "trichy": "tiruchiraappalli",
    "coimbatore": "koyambuttuur", "salem": "sElam", "erode": "iiroDu", "katpadi": "kaaTpaaDi",
    "thiruvananthapuram": "tiruvanantapuram", "trivandrum": "tiruvanantapuram", "ernakulam": "eRaNaakuLam",
    "kozhikode": "kOzhikkOT", "calicut": "kOzhikkOT", "thrissur": "trishshuur", "palakkad": "paalakkaaD",
    "shoranur": "shoraNuur", "kottayam": "koTTayam", "kollam": "kollam", "aluva": "aaluva",
    "bengaluru": "bengaLuuru", "bangalore": "bengaLuuru", "ksr bengaluru": "kee es aar bengaLuuru",
    "mysuru": "maisuuru", "mysore": "maisuuru", "hubballi": "hubbaLLi", "hubli": "hubbaLLi",
    "mangaluru": "mangaLuuru", "mangalore": "mangaLuuru", "davangere": "daavaNagere",
    "mumbai": "mumba-ii", "mumbai central": "mumba-ii senTral", "dadar": "daadar", "thane": "ThaaNE",
    "kalyan": "kalyaaN", "pune": "puNE", "nagpur": "naagpur", "nashik": "naashik", "nasik road": "naashik roD",
    "igatpuri": "igatpurii", "bhusaval": "bhusaaval", "manmad": "manmaaD", "solapur": "solaapur",
    "wardha": "vardhaa", "balharshah": "balhaarshaah", "ballarshah": "balhaarshaah", "aurangabad": "aurangaabaad",
    "new delhi": "na-ii dillii", "delhi": "dillii", "hazrat nizamuddin": "hazrat nizaamuddiin",
    "anand vihar": "aanand vihaar", "agra cantt": "aagraa kainT", "mathura": "mathuraa", "gwalior": "gvaaliyar",
    "jhansi": "jhaansii", "bhopal": "bhopaal", "itarsi": "iTaarsii", "jabalpur": "jabalpur",
    "prayagraj": "prayaagraaj", "allahabad": "ilaahaabaad", "kanpur central": "kaanpur senTral",
    "lucknow": "lakhna-uu", "varanasi": "vaaraaNasii", "gaya": "gayaa", "patna": "paTnaa",
    "mughal sarai": "mugalsaraay", "pt deen dayal upadhyaya": "panDit diindayaal upaadhyaay",
    "howrah": "haavDaa", "sealdah": "siyaaldah", "kharagpur": "khaDagpur", "bhubaneswar": "bhuvaneshvar",
    "cuttack": "kaTak", "puri": "purii", "berhampur": "brahmapur", "brahmapur": "brahmapur",
    "vizianagaram": "vijayanagaram", "srikakulam road": "shriikaakuLam roD", "palasa": "palaasa",
    "raipur": "raaypur", "bilaspur": "bilaaspur", "durg": "durg", "ranchi": "raanchii", "tatanagar": "Taataanagar",
    "guwahati": "guvaahaaTii", "new jalpaiguri": "nyuu jalpaaiguDii", "dibrugarh": "Dibrugaḍh",
    "ahmedabad": "ahmadaabaad", "vadodara": "vaDodaraa", "surat": "suurat", "rajkot": "raajkoT",
    "jaipur": "jaypur", "ajmer": "ajmer", "jodhpur": "jodhpur", "udaipur city": "udaypur siTii",
    "amritsar": "amritsar", "ludhiana": "ludhiyaanaa", "jalandhar city": "jalandhar siTii",
    "chandigarh": "chanDiigaDh", "ambala cantt": "ambaalaa kainT", "jammu tawi": "jammuu tavii",
    "madgaon": "maDgaanv", "vasco da gama": "vaasko Da gaamaa", "karwar": "kaaravaar",
    "ratnagiri": "ratnaagiri", "panvel": "panvel",
}

# Station-name words that are English — read them the way announcers do.
WORD_SAY = {
    "jn": "jankshan", "junction": "jankshan", "rd": "roD", "road": "roD", "cantt": "kainT",
    "cant": "kainT", "cantonment": "kainTonmenT", "halt": "haalT", "terminus": "Tarminas",
    "term": "Tarminas", "central": "senTral", "city": "siTii", "town": "Taaun", "new": "nyuu",
    "old": "olD", "east": "iisT", "west": "vesT", "north": "narth", "south": "saauth", "cant.": "kainT",
    "stn": "sTeshan", "station": "sTeshan", "port": "porT", "bazar": "baazaar", "nagar": "nagar",
    "colony": "kaalonii", "cabin": "keebin", "fort": "forT", "main": "meen", "bridge": "brij",
    "gate": "geT", "camp": "kaimp", "mill": "mil", "park": "paark", "chowk": "chauk", "garh": "gaDh",
    "abad": "aabaad", "pur": "pur", "nt": "",
}

_LETTER_SAY = {
    "a": "e", "b": "bii", "c": "sii", "d": "Dii", "e": "ii", "f": "eph", "g": "jii", "h": "ech",
    "i": "aai", "j": "je", "k": "ke", "l": "el", "m": "em", "n": "en", "o": "o", "p": "pii",
    "q": "kyuu", "r": "aar", "s": "es", "t": "Tii", "u": "yuu", "v": "vii", "w": "Dablyuu",
    "x": "eks", "y": "vaai", "z": "zeD",
}

# Phoneme inventory (Devanagari as the pivot script).
_V = {  # vowel: (independent letter, dependent sign)
    "a": ("अ", ""), "aa": ("आ", "ा"), "i": ("इ", "ि"), "ii": ("ई", "ी"), "u": ("उ", "ु"),
    "uu": ("ऊ", "ू"), "e": ("ए", "े"), "E": ("ए", "े"), "O": ("ओ", "ो"),
    # short e / o: only Dravidian scripts have them (ఎ ఒ, எ ஒ, ಎ ಒ, എ ഒ)
    "e_": ("ऎ", "ॆ"), "o_": ("ऒ", "ॊ"), "ai": ("ऐ", "ै"), "o": ("ओ", "ो"), "au": ("औ", "ौ"), "ri": ("ऋ", "ृ"),
}
_C = {
    "k": "क", "kh": "ख", "g": "ग", "gh": "घ", "ch": "च", "chh": "छ", "j": "ज", "jh": "झ",
    "T": "ट", "Th": "ठ", "D": "ड", "Dh": "ढ", "N": "ण", "t": "त", "th": "थ", "d": "द", "dh": "ध",
    "n": "न", "p": "प", "ph": "फ", "f": "फ़", "b": "ब", "bh": "भ", "m": "म", "y": "य", "r": "र",
    "l": "ल", "L": "ळ", "v": "व", "w": "व", "sh": "श", "Sh": "ष", "s": "स", "h": "ह", "z": "ज़",
    "zh": "ऴ", "R": "र", "q": "क", "ḍh": "ढ़",
}
_VIRAMA = "्"

# Roman input tokens -> phonemes, longest first. Lower-case input except
# the capital retroflex markers used by STATION_SAY / WORD_SAY.
_TOKENS = sorted([
    ("chh", "C:chh"), ("ksh", "C:k C:Sh"), ("aa", "V:aa"), ("ee", "V:ii"), ("ii", "V:ii"), ("oo", "V:uu"),
    ("uu", "V:uu"), ("E", "V:E"), ("O", "V:O"), ("ai", "V:ai"), ("au", "V:au"), ("ou", "V:au"), ("ei", "V:e"), ("ey", "V:e"),
    ("Th", "C:Th"), ("Dh", "C:Dh"), ("ḍh", "C:ḍh"), ("kh", "C:kh"), ("gh", "C:gh"), ("ch", "C:ch"),
    ("jh", "C:jh"), ("th", "C:th"), ("dh", "C:dh"), ("ph", "C:ph"), ("bh", "C:bh"), ("sh", "C:sh"),
    ("Sh", "C:Sh"), ("zh", "C:zh"), ("ck", "C:k"), ("qu", "C:k C:v"), ("x", "C:k C:s"),
    ("a", "V:a"), ("i", "V:i"), ("u", "V:u"), ("e", "V:e"), ("o", "V:o"),
    ("k", "C:k"), ("g", "C:g"), ("c", "C:k"), ("j", "C:j"), ("T", "C:T"), ("D", "C:D"), ("N", "C:N"),
    ("t", "C:t"), ("d", "C:d"), ("n", "C:n"), ("p", "C:p"), ("f", "C:f"), ("b", "C:b"), ("m", "C:m"),
    ("y", "C:y"), ("r", "C:r"), ("R", "C:R"), ("l", "C:l"), ("L", "C:L"), ("v", "C:v"), ("w", "C:w"),
    ("s", "C:s"), ("h", "C:h"), ("z", "C:z"), ("q", "C:q"),
], key=lambda kv: -len(kv[0]))


def _phonemes(word: str) -> list:
    out, i = [], 0
    while i < len(word):
        for tok, ph in _TOKENS:
            if word.startswith(tok, i):
                # "c" before e/i/y sounds "s" (Cuttack vs Cidade).
                if tok == "c" and i + 1 < len(word) and word[i + 1] in "eiy":
                    ph = "C:s"
                out.extend(ph.split())
                i += len(tok)
                break
        else:
            i += 1  # punctuation etc.
    # "y" after a consonant at the end of a word is a vowel: "...dry" -> "drii".
    if len(out) >= 2 and out[-1] == "C:y" and out[-2].startswith("C:"):
        out[-1] = "V:ii"
    return out


def _to_devanagari(phs: list, final_virama: bool, short_eo: bool = False) -> str:
    s = []
    for idx, ph in enumerate(phs):
        kind, val = ph.split(":", 1)
        if short_eo and val in ("e", "o"):
            val += "_"
        prev = phs[idx - 1] if idx else None
        nxt = phs[idx + 1] if idx + 1 < len(phs) else None
        if kind == "V":
            if prev and prev.startswith("C:"):
                s.append(_V[val][1])
            else:
                s.append(_V[val][0])
        else:
            s.append(_C[val])
            if nxt is None:
                if final_virama:
                    s.append(_VIRAMA)
            elif nxt.startswith("C:"):
                s.append(_VIRAMA)
    return "".join(s)


def _roman_word_to_phonetic(w: str) -> str:
    """Lower-cases a railway-spelled word and applies simple Indian
    place-name conventions: a word-final "a" is long (Agra, Mathura)."""
    lw = w.lower()
    if lw in WORD_SAY:
        return WORD_SAY[lw]
    # An all-consonant word like "Csmt"/"Ltt" is an abbreviation: spell it.
    if len(lw) <= 5 and not re.search(r"[aeiou]", lw):
        return " ".join(_LETTER_SAY.get(ch, ch) for ch in lw)
    if len(lw) > 2 and lw.endswith("a") and not lw.endswith("aa"):
        lw = lw + "a"
    return lw


def _phonetic(name: str) -> str:
    key = re.sub(r"\s+", " ", str(name or "").strip().lower())
    if key in STATION_SAY:
        return STATION_SAY[key]
    # Try the name without a trailing Jn / Road / Cantt etc.
    words = key.split(" ")
    for cut in range(len(words) - 1, 0, -1):
        head = " ".join(words[:cut])
        if head in STATION_SAY:
            return STATION_SAY[head] + " " + " ".join(_roman_word_to_phonetic(x) for x in words[cut:])
    return " ".join(_roman_word_to_phonetic(x) for x in re.findall(r"[A-Za-z]+", str(name or "")))


# Target scripts: (script, block offset from Devanagari, write a virama on a
# word-final consonant?). Dravidian scripts need it, or "Nagpur" is read
# "Nagpura"; North Indian scripts drop the final vowel by themselves.
_SCRIPT = {
    "hi": ("deva", 0x0000, False), "mr": ("deva", 0x0000, False), "ne": ("deva", 0x0000, False),
    "kok": ("deva", 0x0000, False), "mai": ("deva", 0x0000, False), "doi": ("deva", 0x0000, False),
    "brx": ("deva", 0x0000, False), "sa": ("deva", 0x0000, True), "sat": ("deva", 0x0000, False),
    "bn": ("beng", 0x0080, False), "as": ("asm", 0x0080, False), "mni": ("beng", 0x0080, False),
    "pa": ("guru", 0x0100, False), "gu": ("gujr", 0x0180, False), "or": ("orya", 0x0200, False),
    "ta": ("taml", 0x0280, True), "te": ("telu", 0x0300, True), "kn": ("knda", 0x0380, True),
    "ml": ("mlym", 0x0400, True),
}

# Letters a script lacks -> the nearest one it has (Devanagari in, Devanagari out;
# applied before the block shift).
_FOLD = {
    "taml": {"ख": "क", "ग": "क", "घ": "क", "छ": "च", "झ": "ज", "ठ": "ट", "ड": "ट", "ढ": "ट",
             "थ": "त", "द": "त", "ध": "त", "फ": "प", "ब": "प", "भ": "प", "श": "ष",
             "़": "", "ऋ": "रि", "ृ": "ि"},
    "telu": {"़": "", "ऴ": "ळ"},
    "knda": {"़": "", "ऴ": "ळ"},
    "mlym": {"़": ""},
    "beng": {"व": "ब", "ळ": "ल", "ऴ": "ल"},
    "asm": {"ळ": "ल", "ऴ": "ल"},
    "guru": {"ष": "श", "ऋ": "रि", "ृ": "ि", "ऴ": "ळ"},
    "gujr": {"ऴ": "ळ"},
    "orya": {"ऴ": "ळ"},
    "deva": {"ऴ": "ळ"},
}


def _shift(text: str, script: str, offset: int) -> str:
    fold = _FOLD.get(script, {})
    for a, b in fold.items():
        text = text.replace(a, b)
    if offset == 0:
        return text
    out = []
    for ch in text:
        cp = ord(ch)
        if 0x0900 <= cp <= 0x097F:
            out.append(chr(cp + offset))
        else:
            out.append(ch)
    res = "".join(out)
    if script in ("beng", "asm"):
        # য alone reads "j"; the "y" sound is য় (except as a ya-phala).
        res = re.sub("(?<!\u09CD)\u09AF", "\u09AF\u09BC", res)
    if script == "asm":
        # Assamese uses the Bengali block with its own ra / wa.
        res = res.replace("\u09B0", "\u09F0").replace("\u09B5", "\u09F1")
    if script == "taml":
        # Tamil writes ந only at the start of a word (or before த); ன elsewhere.
        res = re.sub("(?<=[\u0B80-\u0BFF])\u0BA8(?!\u0BCD\u0BA4)", "\u0BA9", res)
    if script == "mlym":
        # Word-final n / r / l / L / N take the chillu form (no trailing "u").
        chillu = {"\u0D28": "\u0D7B", "\u0D30": "\u0D7C", "\u0D32": "\u0D7D", "\u0D33": "\u0D7E", "\u0D23": "\u0D7A"}
        res = re.sub("([\u0D28\u0D30\u0D32\u0D33\u0D23])\u0D4D$", lambda m: chillu[m.group(1)], res)
        res = re.sub("\u0D2E\u0D4D$", "\u0D02", res)  # final m -> anusvara
    if script == "orya":
        # Odia ya / wa.
        res = res.replace("\u0B2F", "\u0B5F").replace("\u0B35", "\u0B71")
    return res


def _render(phonetic: str, lang: str) -> str:
    script, offset, final_virama = _SCRIPT[lang]
    dravidian = script in ("taml", "telu", "knda", "mlym")
    parts = []
    for word in phonetic.split():
        phs = _phonemes(word)
        if phs:
            parts.append(_shift(_to_devanagari(phs, final_virama, dravidian), script, offset))
    return " ".join(parts)


_ROMAN_EXPAND = {"jn": "Junction", "rd": "Road", "cantt": "Cantonment", "cant": "Cantonment",
                 "stn": "Station", "term": "Terminus"}


def _tidy_roman(name: str) -> str:
    """English / Urdu / Kashmiri / Sindhi voices read the Roman spelling —
    never ALL CAPS (voices spell those letter by letter), abbreviations
    expanded."""
    words = []
    for w in re.findall(r"[A-Za-z]+", str(name)):
        lw = w.lower()
        if lw in _ROMAN_EXPAND:
            words.append(_ROMAN_EXPAND[lw])
        elif len(lw) <= 5 and not re.search(r"[aeiouy]", lw):
            words.append(" ".join(lw.upper()))  # "Csmt" -> "C S M T"
        else:
            words.append(w.capitalize())
    return " ".join(words)


def say_station(name: Optional[str], lang: str) -> str:
    """The station/village name as the `lang` voice should read it."""
    if not name:
        return ""
    lang = i18n_notify.normalize(lang)
    if lang not in _SCRIPT:
        return _tidy_roman(name)
    return _render(_phonetic(name), lang) or str(name)


# ---------------------------------------------------------------------------
# Whole announcements.
# ---------------------------------------------------------------------------
_TRAIN_WORDS = {"exp": "express", "expr": "express", "sf": "superfast", "spl": "special",
                "pass": "passenger", "psgr": "passenger", "shtbdi": "shatabdi"}
_TRAIN_SAY = {"express": "eksapres", "superfast": "suparfaasT", "special": "speshal",
              "passenger": "paisenjar", "mail": "meel", "memu": "memuu", "demu": "Demuu",
              "intercity": "inTarsiTii", "garib": "gariib", "shatabdi": "shataabdii", "duronto": "duronto",
              "humsafar": "hamsafar", "vande": "vande", "bharat": "bhaarat", "sampark": "sampark",
              "kranti": "kraanti", "rajdhani": "raajdhaanii", "jan": "jan", "antyodaya": "antyOdaya"}


def say_train_name(name: Optional[str], lang: str) -> str:
    """Train names ("Venkatadri Exp", "Rajdhani") read like station names,
    with "Exp" / "SF" / "Spl" expanded."""
    if not name:
        return ""
    words = [_TRAIN_WORDS.get(w.lower(), w.lower()) for w in re.findall(r"[A-Za-z]+", str(name))]
    lang = i18n_notify.normalize(lang)
    if lang not in _SCRIPT:
        return " ".join(w.capitalize() for w in words)
    out = [_render(_TRAIN_SAY[w], lang) if w in _TRAIN_SAY else say_station(w, lang) for w in words]
    return " ".join(x for x in out if x)


def _train_part(train_number, train_name, lang: str) -> str:
    name = f", {say_train_name(train_name, lang)}," if train_name else ","
    return ann(lang, "train", num=spoken_train_number(train_number), name=name)


def running_status(train_number, rs: dict, lang: Optional[str]) -> str:
    """Announcement for a running-status update (the "Notify me every N
    min" push and the final "reached" one)."""
    lang = i18n_notify.normalize(lang)
    if not rs:
        return ""
    out = [ann(lang, "intro"), _train_part(train_number, rs.get("train_name"), lang)]
    if rs.get("completed"):
        st = say_station(rs.get("destination"), lang)
        t = rs.get("destination_eta")
        out[-1] += " " + (ann(lang, "reached_at", st=st, t=spoken_time(t, lang, at=True)) if t else ann(lang, "reached", st=st))
        out.append(ann(lang, "thanks"))
        return " ".join(out)
    if rs.get("crossed_station"):
        verb = {"Departed": "departed", "Arrived at": "arrived", "Reached": "reached"}.get(
            rs.get("crossed_verb") or "", "crossed")
        if verb == "reached":
            verb = "arrived"
        st, t = say_station(rs["crossed_station"], lang), rs.get("crossed_time")
        out[-1] += " " + (ann(lang, f"{verb}_at", st=st, t=spoken_time(t, lang, at=True)) if t else ann(lang, verb, st=st))
    else:
        out[-1] += " " + ann(lang, "yet")
    if rs.get("next_station"):
        st = say_station(rs["next_station"], lang)
        if rs.get("km_to_next") is not None:
            out.append(ann(lang, "km_to", km=spoken_km(rs["km_to_next"], lang), st=st))
        else:
            out.append(ann(lang, "next", st=st))
    if rs.get("next_halt"):
        bits = [ann(lang, "halt", st=say_station(rs["next_halt"], lang))]
        if rs.get("next_halt_eta"):
            bits.append(ann(lang, "exp", t=spoken_time(rs["next_halt_eta"], lang)))
            mins = rs.get("next_halt_minutes")
            if mins is not None and mins <= 90:
                bits.append(ann(lang, "now") if mins < 1 else ann(lang, "in_min", n=int(mins)))
        out.append(", ".join(bits) + _STOP.get(lang, "."))
    d = rs.get("delay_minutes")
    if d is not None:
        out.append(delay_sentence(d, lang))
    out.append(ann(lang, "thanks"))
    return " ".join(x for x in out if x)


def delay_sentence(minutes, lang: str) -> str:
    try:
        minutes = int(minutes)
    except (TypeError, ValueError):
        return ""
    if minutes <= 0:
        return ann(lang, "on_time")
    h, m = divmod(minutes, 60)
    return ann(lang, "late_hm", h=h, m=m) if h else ann(lang, "late_m", n=m)


def approach(train_number, station: Optional[str], minutes: Optional[float], lang: Optional[str],
             eta_text: Optional[str] = None, km: Optional[float] = None,
             delay_minutes: Optional[int] = None, train_name: Optional[str] = None) -> str:
    """Announcement for "train arriving at your station in ~10 min"."""
    lang = i18n_notify.normalize(lang)
    st = say_station(station, lang) if station else ""
    when = ann(lang, "appr_now") if (minutes is not None and minutes < 1) else ann(
        lang, "appr_soon", n=int(round(minutes)) if minutes is not None else 10)
    out = [ann(lang, "intro"), _train_part(train_number, train_name, lang) + " " + ann(lang, "appr", st=st, when=when)]
    if km is not None and station:
        out.append(ann(lang, "km_to", km=spoken_km(km, lang), st=st))
    if eta_text:
        out.append(ann(lang, "exp", t=spoken_time(eta_text, lang)) + _STOP.get(lang, "."))
    if delay_minutes is not None:
        out.append(delay_sentence(delay_minutes, lang))
    out.append(ann(lang, "thanks"))
    return " ".join(x for x in out if x)


_KM_RE = re.compile(r"(\d+(?:\.\d+)?)\s*(?:kms?|kilomet(?:re|er)s?|किमी|కి\.మీ|கி\.மீ|ಕಿ\.ಮೀ|കി\.മീ|কিমি|কি\.মি\.|ਕਿਮੀ|કિમી|କି\.ମି\.|کلومیٹر|ڪلوميٽر)(?![A-Za-z])")
_TIME_RE = re.compile(r"\b([01]?\d|2[0-3]):([0-5]\d)\b")


def generic(title: str, body: str, lang: Optional[str]) -> str:
    """Any other notification: same words, but numbers, distances and times
    spelled for speech, emoji and separators removed, then "Thank you"."""
    lang = i18n_notify.normalize(lang)
    text = f"{title}. {body}" if body else str(title or "")
    text = re.sub(r"[\U0001F300-\U0001FAFF☀-➿️]", "", text)
    text = text.replace("·", ",").replace("\n", ". ")
    text = _KM_RE.sub(lambda m: spoken_km(m.group(1), lang), text)
    text = _TIME_RE.sub(lambda m: spoken_time(m.group(0), lang), text)
    text = re.sub(r"\b(\d{5})\b", lambda m: spoken_train_number(m.group(1)), text)
    text = re.sub(r"\s*\.\s*\.", ".", text)
    text = re.sub(r"\s+", " ", text).strip()
    return f"{ann(lang, 'intro')} {text} {ann(lang, 'thanks')}"


def delay_alert(train_number, lang: Optional[str], delay_minutes: Optional[int], station: Optional[str] = None,
                running: Optional[dict] = None, eta_text: Optional[str] = None,
                minutes: Optional[float] = None, km: Optional[float] = None) -> str:
    """Announcement for a Delay Alert (bell) push."""
    lang = i18n_notify.normalize(lang)
    rs = running or {}
    if rs:
        # Where the train is, then the delay — same as the status update.
        text = running_status(train_number, {**rs, "delay_minutes": delay_minutes}, lang)
        return text
    out = [ann(lang, "intro"), _train_part(train_number, None, lang).rstrip(",") + _STOP.get(lang, ".")]
    if station and (eta_text or minutes is not None or km is not None):
        bits = [ann(lang, "halt", st=say_station(station, lang))]
        if eta_text:
            bits.append(ann(lang, "exp", t=spoken_time(eta_text, lang)))
        if minutes is not None:
            bits.append(ann(lang, "now") if minutes < 1 else ann(lang, "in_min", n=int(round(minutes))))
        out.append(", ".join(bits) + _STOP.get(lang, "."))
        if km is not None:
            out.append(ann(lang, "km_to", km=spoken_km(km, lang), st=say_station(station, lang)))
    if delay_minutes is not None:
        out.append(delay_sentence(delay_minutes, lang))
    out.append(ann(lang, "thanks"))
    return " ".join(x for x in out if x)
