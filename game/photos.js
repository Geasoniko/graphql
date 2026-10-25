// ============================================================
//  НАСТРОЙКИ ИГРЫ — фото, папка Google Drive, фильмы
//  Подробная инструкция на русском — в README.md
// ============================================================

window.GALLERY_CONFIG = {
  // Надпись на стене последнего зала галереи
  title: 'Наша история 💕',

  // ---------- ФОТО ----------
  // 1) Папка Google Drive: все фото из неё сами повесятся в галерею.
  //    Вставьте ссылку на папку (папка открыта «всем, у кого есть ссылка»)
  //    и адрес скрипта driveListUrl (как его сделать — README, 2 минуты).
  driveFolder: '',
  driveListUrl: '',

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
  // Загрузите фильм в Google Drive → «Поделиться» → «Все, у кого есть ссылка»
  // → вставьте ссылку в url. Подходит и ссылка YouTube или прямая ссылка на .mp4.
  // Если url пустой — в кино можно будет выбрать файл фильма с телефона/ноутбука.
  movies: [
    { title: 'Фильм 1', url: '' },
    { title: 'Фильм 2', url: '' },
    { title: 'Фильм 3', url: '' },
  ],

  // Необязательно: ключ Google API вместо скрипта (для папки)
  driveApiKey: '',

  // Необязательно: свой сервер PeerJS для игры вдвоём
  // Пример: { host: 'localhost', port: 9000, path: '/', secure: false }
  peerServer: null,
};
