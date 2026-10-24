// ============================================================
//  НАСТРОЙКИ ГАЛЕРЕИ
//  Сюда вставьте ссылки на ваши фото из Google Drive.
//
//  Как получить ссылку:
//    1. Откройте фото в Google Drive → «Поделиться» (Share).
//    2. «Общий доступ» → «Все, у кого есть ссылка» (Anyone with the link).
//    3. «Копировать ссылку» и вставьте её ниже в кавычках, через запятую.
//
//  Ссылки также можно добавить прямо в игре кнопкой 🖼️ —
//  они сохранятся в браузере и отправятся партнёру.
// ============================================================

window.GALLERY_CONFIG = {
  // Надпись на главной стене галереи
  title: 'Наша история 💕',

  // Ссылки на фото (Google Drive или любые прямые ссылки на картинки)
  photos: [
    'https://drive.google.com/file/d/1zCI0UNRqZ726-qrvF10B4sf4qDqTX6cd/view?usp=drivesdk',
    'https://drive.google.com/file/d/1PnEOngW5obAMIBUH06HYRfQkrxQwYldw/view?usp=drivesdk',
    'https://drive.google.com/file/d/1gJKOl_JSdPjidxNqc43mVQ2bo109vu7p/view?usp=drivesdk',
    'https://drive.google.com/file/d/1kUjHZpN_IcXJfSu7Qxy1mJxdKcByWZ_1/view?usp=drivesdk',
    'https://drive.google.com/file/d/18tQ-PVxcpFzxPyr-41cqArDvVg8R-XHN/view?usp=drivesdk',
    'https://drive.google.com/file/d/1uCPG81OVgGzFx9Kc4Fr2cmrEndYSLHkG/view?usp=drivesdk',
    'https://drive.google.com/file/d/122RpN6M1ewUkXGzUVoJo1Q_zBoVMlOnW/view?usp=drivesdk',
  ],

  // Необязательно: ключ Google API (Drive API), чтобы можно было
  // вставлять ссылку на целую ПАПКУ вместо отдельных фото.
  // Папка тоже должна быть открыта «всем, у кого есть ссылка».
  driveApiKey: '',

  // Необязательно: свой сервер PeerJS для игры вдвоём.
  // По умолчанию используется бесплатный публичный сервер PeerJS.
  // Пример: { host: 'localhost', port: 9000, path: '/', secure: false }
  peerServer: null,
};
