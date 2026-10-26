export const colors = ['#ff8a3d', '#5ec8ff', '#b48cff', '#4fe0a8', '#ffd166', '#ff6f91'];
export const ORIGINAL_COLOR = '#9aa3b2';
export const STEMS = [['vocals', 'Vocals', '#ff8a3d'], ['drums', 'Drums', '#5ec8ff'], ['bass', 'Bass', '#b48cff'],
  ['guitar', 'Guitar', '#4fe0a8'], ['piano', 'Piano', '#ffd166'], ['other', 'Other', '#ff6f91']];
export const DEFAULT_STEMS = ['vocals', 'drums', 'bass', 'guitar'];
export const AUDIO_EXTENSIONS = ['.wav', '.flac', '.mp3', '.opus', '.ogg', '.m4a', '.aac', '.aiff', '.aif'];
export const SEPARATION_STEPS = [['prepare', 'Prepare audio'], ['load', 'Load AI model'], ['separate', 'Separate stems'], ['finalize', 'Save stems']];
export const GUITAR_STEPS = [['prepare', 'Load model'], ['separate', 'Split guitar'], ['finalize', 'Save tracks']];
export const YOUTUBE_STEPS = [['download', 'Download audio'], ['finalize', 'Create project']];
export const SETUP_STEPS = [['prepare', 'Check setup'], ['download', 'Download components'], ['install', 'Install packages'], ['finalize', 'Finish']];
export const SETUP_STAGE_LABEL = {ffmpeg: 'FFmpeg', separation: 'the separation engine', youtube: 'YouTube support'};
export const SETUP_PHASE_TITLE = {prepare: 'Checking what’s needed', download: 'Downloading components', install: 'Installing packages', finalize: 'Finishing up'};
export const SETUP_PHASE_SUB = {prepare: 'Verifying the runtime, FFmpeg and the separation engine.', download: 'Fetching the files above.', install: 'This can take several minutes.', finalize: 'Verifying everything works.'};
export const ORIGINAL_FILE = '__original__';
