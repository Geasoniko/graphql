// ============================================================
//  НАСТРОЙКИ ИГРЫ — фото, папка Google Drive, фильмы
//  Подробная инструкция на русском — в README.md
// ============================================================

// где искать фильм: сначала папка game/films, потом Releases на GitHub
function film(name) {
  return ['films/' + name, 'https://github.com/Geasoniko/graphql/releases/download/films/' + name];
}

window.GALLERY_CONFIG = {
  // Надпись на стене последнего зала галереи
  title: ' 💕',

  // ---------- ФОТО ----------
  // 1) Папка Google Drive: все фото из неё сами повесятся в галерею.
  //    Вставьте ссылку на папку (папка открыта «всем, у кого есть ссылка»)
  //    и адрес скрипта driveListUrl (как его сделать — README, 2 минуты).
  driveFolder: 'https://drive.google.com/drive/folders/1tqSZIAm_YwIo5Yv6njTpPEg1Wgn902aV?usp=sharing',
  driveListUrl: 'https://script.google.com/macros/s/AKfycbwveBLXZcN0ZK5H9hXGGqPrRQBLLSzseurIu-XzS0im6zgdgY58sbjf4jy56U5nibaF/exec',

  // 2) Или отдельные фото (тоже Google Drive, доступ «все, у кого есть ссылка»)
  photos: [
    'https://drive.google.com/file/d/1zCI0UNRqZ726-qrvF10B4sf4qDqTX6cd/view?usp=drivesdk',
    'https://drive.google.com/file/d/1PnEOngW5obAMIBUH06HYRfQkrxQwYldw/view?usp=drivesdk',
    'https://drive.google.com/file/d/1gJKOl_JSdPjidxNqc43mVQ2bo109vu7p/view?usp=drivesdk',
    'https://drive.google.com/file/d/1kUjHZpN_IcXJfSu7Qxy1mJxdKcByWZ_1/view?usp=drivesdk',
    'https://drive.google.com/file/d/18tQ-PVxcpFzxPyr-41cqArDvVg8R-XHN/view?usp=drivesdk',
    'https://drive.google.com/file/d/1uCPG81OVgGzFx9Kc4Fr2cmrEndYSLHkG/view?usp=drivesdk',
    'https://drive.google.com/file/d/122RpN6M1ewUkXGzUVoJo1Q_zBoVMlOnW/view?usp=drivesdk',
  ],

  // ---------- ФИЛЬМЫ ДЛЯ КИНОТЕАТРА ----------
  // Файлы .mp4 с ТАКИМИ именами загрузите на GitHub (инструкция в README):
  //   • в папку game/films/                        — если файл меньше 100 МБ
  //   • или в Releases с тегом films               — если файл большой (до 2 ГБ)
  // Игра сама попробует оба места по очереди.
  movies: [
    { title: 'Ла-Ла Ленд', url: film('lalaland.mp4') },
    { title: 'История игрушек 5', url: film('toystory5.mp4') },
    { title: 'Миньоны и монстры', url: film('minions-monsters.mp4') },
  ],

  // Необязательно: ключ Google API вместо скрипта (для папки)
  driveApiKey: '',

  // Необязательно: свой сервер PeerJS для игры вдвоём
  // Пример: { host: 'localhost', port: 9000, path: '/', secure: false }
  peerServer: null,
};
