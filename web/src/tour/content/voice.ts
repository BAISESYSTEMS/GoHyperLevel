import type { Tour } from '../types';

/** Stimme: speech providers of the sub-account (text to speech, speech to text), the phone agent's own voice, push-to-talk of the HyperLevel Agent. */
export const VOICE_TOURS: Tour[] = [
  {
    id: 'voice',
    title: 'Stimme & Spracherkennung',
    summary: 'Eigene Stimme für Telefonagent und KI-Agent, Mikrofon-Taste, Voicemail als Text – mit deinem Anbieter (ElevenLabs, OpenAI, Deepgram, lokal …).',
    icon: 'audio',
    group: 'ai',
    perm: 'settings',
    minutes: 6,
    routes: ['settings/voice'],
    keywords: 'stimme sprache sprachausgabe spracherkennung tts stt elevenlabs deepgram cartesia whisper telefon voicemail mikrofon vorlesen diktieren live stream',
    learned: ['Anbieter für Sprachausgabe und Spracherkennung wählen und die Stimme testen', 'Den KI-Telefonagenten mit eigener Stimme telefonieren lassen – live oder in Aufnahme-Runden', 'Mikrofon-Taste und Vorlesen im KI-Agenten einstellen', 'Voicemails automatisch als Text bekommen'],
    docs: { label: 'Stimme', file: 'voice' },
    steps: [
      { title: 'Stimme und Zuhören', route: 'settings/voice', target: 'voice-page', text: 'Hier legst du fest, mit welchem Anbieter {brand} spricht und zuhört: am Telefon, im KI-Agenten und bei Voicemails. Die Schlüssel liegen unter **KI-Anbieter** – ohne Anbieter bleibt alles wie bisher.' },
      { title: 'Sprachausgabe', target: 'voice-tts', text: 'Welcher Anbieter spricht, mit welchem Modell, in welcher Sprache und wie schnell? „Automatisch“ nimmt die Zuordnung aus den KI-Anbietern. Anbieter mit „Live“ können am Telefon streamen.' },
      { title: 'Die Stimme', target: 'voice-voice', text: 'Mit **Stimmen laden** zeigt dir der Anbieter seine Stimmen. Du kannst auch eine Stimmen-ID selbst eintragen, etwa eine eigene geklonte Stimme.' },
      { title: 'Stimme testen', target: 'voice-test', text: 'Spricht einen Satz mit den aktuellen Einstellungen – noch ungespeichert. So hörst du sofort, ob Stimme, Tempo und Sprache passen.' },
      { title: 'Spracherkennung', target: 'voice-stt', text: 'Wer wandelt Gesprochenes in Text um? Für Telefonate sind Deepgram und AssemblyAI live, alle anderen erkennen Satz für Satz. Mit **Mikrofon testen** prüfst du Anbieter und Mikrofon.' },
      { title: 'Telefon mit eigener Stimme', target: 'voice-phone-engine', text: 'Standard ist die Stimme von Twilio. Mit „Eigener Anbieter“ spricht der KI-Telefonagent mit deiner Stimme – live per Stream oder in Aufnahme-Runden. Fällt der Anbieter aus, spricht Twilio weiter.' },
      { title: 'Was beim nächsten Anruf passiert', target: 'voice-phone-plan', text: 'Hier steht, welcher Weg und welche Anbieter genutzt werden – und was noch fehlt, etwa die öffentliche https-Adresse für den Live-Stream.' },
      { title: 'Antwortzeiten', target: 'voice-latency', optional: true, text: 'Nach den ersten Anrufen siehst du, wie schnell der Agent antwortet: Erkennen, KI und Sprachausgabe einzeln. Unter etwa einer Sekunde fühlt sich gut an.', missing: 'Sobald es Telefonate mit eigener Stimme gab, erscheinen hier die Antwortzeiten.' },
      { title: 'HyperLevel Agent', target: 'voice-agent', text: 'Die Mikrofon-Taste im KI-Agenten nimmt auf, erkennt und legt den Text zum Prüfen ins Feld. Antworten lassen sich vorlesen. Änderungen am CRM bestätigst du immer selbst.' },
      { title: 'Voicemails', target: 'voice-voicemail', text: 'Voicemails werden mit deiner Spracherkennung zu Text, auf Wunsch mit kurzer Zusammenfassung. Die Transkription von Twilio dann ausschalten.' },
    ],
  },
];
