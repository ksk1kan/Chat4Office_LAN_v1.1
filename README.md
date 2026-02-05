# Chat4Office (LAN Web Uygulaması) v1.1

Bu sürümde:
- ✅ DM okundu bilgisi + okunmayan sayaç
- ✅ Not/hatırlatma okundu bilgisi
- ✅ "Bitir" yapan kişi kapatır + kim bitirdiği loglanır
- ✅ Not silme: sadece oluşturan kişi + admin

## Kurulum (Windows)
PowerShell'de `npm` engeli alırsan en kolayı **CMD** kullanmak.

1) `npm install`
2) `npm start`
3) Sunucu PC: http://localhost:3000
4) Diğer PC: http://SUNUCU_IP:3000

SUNUCU_IP: `ipconfig` -> IPv4 Address

## İlk giriş
- kullanıcı: admin
- şifre: admin1234
Admin panel: /admin.html

## Ses
En stabil yöntem:
- `public/sounds/notify.wav` dosyasını değiştir
- Admin panelde Ses URL: `/sounds/notify.wav`

YouTube linki tarayıcı kısıtlarına takılabilir. Bu yüzden varsayılan WAV daha stabil.
