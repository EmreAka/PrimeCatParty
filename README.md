# PrimeCatParty 🐱🍿

Prime Video'yu arkadaşlarınla senkron izlemek için bir Chrome eklentisi (Manifest V3) ve küçük bir WebSocket sunucusu.

Biri durdurunca, devam ettirince ya da sarınca odadaki herkesin videosu aynı yere gelir. Ekranın ortasında da "Emre durdurdu", "Barış 1:16:09 konumuna sardı" gibi bir bildirim çıkar.

## Özellikler

- **Oda sistemi:** Popup'tan oda oluştur, 8 karakterlik kodu arkadaşına gönder. Bir odada en fazla 8 kişi olabilir. Kimlik doğrulaması yok, kodu bilen girer.
- **Herkes kontrol edebilir:** Durdurma, devam ettirme, sarma ve hız değişikliği odadaki herkese uygulanır.
- **Bildirimler:** Popup'ta girdiğin isimle kimin ne yaptığı ekranın ortasında görünür. Tam ekranda da çalışır.
- **Saat senkronu:** Sunucuyla saat farkı ölçülür. Böylece "şu saniyedeydim" bilgisi gecikmeden bağımsız olarak doğru yorumlanır.
- **Kayma düzeltmesi:** Host olmayanlar arada bir host'a göre hizalanır:

  | Fark | Davranış |
  | --- | --- |
  | < 0,3 sn | Dokunulmaz |
  | 0,3 – 2 sn | Oynatma hızı 1,05x / 0,95x yapılır, fark kapanınca 1x'e döner |
  | > 2 sn | Doğrudan sarılır (iki sarma arasında en az 5 sn) |

- **Reklam arası:** Birinde reklam başlarsa diğerleri bekler, herkes reklamdan çıkınca devam edilir.
- **Buffer beklemesi:** Birinin videosu yükleniyorsa diğerleri durup onu bekler.
- **İçerik kontrolü:** Biri farklı bir diziye veya filme geçerse (URL'deki içerik kimliği değişirse) uyarı çıkar ve senkron durur.
- **Geç katılma:** Sonradan gelen, odanın son durumuna tek hamlede senkronlanır.
- **Yeniden bağlanma:** Bağlantı koparsa 1, 2, 4… saniye aralıklarla (en fazla 30 sn) yeniden denenir.

## Proje yapısı

```
extension/                 Chrome eklentisi
  manifest.json
  background.js            sekme başına oda, rozet, açık sekmelere betik ekleme
  content/
    debug.js               log ve hata ayıklama yardımcıları
    transport.js           WebSocket sarmalayıcı, yeniden bağlanma
    sync.js                saat senkronu ve kayma düzeltmesi
    player.js              <video> bulma, olay yakalama, oynat/durdur/sar
    overlay.js             durum göstergesi ve ekran bildirimleri
    main.js                hepsini birbirine bağlayan kısım
  popup/
    popup.html / popup.js  isim, oda oluştur/katıl, durum, ayarlar, hata ayıklama

server/                    Node.js WebSocket sunucusu (tek bağımlılık: ws)
  index.js
  rooms.js
  Dockerfile

.github/workflows/docker.yml   image build + VPS'e deploy
```

## Eklentiyi kurma

1. Chrome'da `chrome://extensions` sayfasını aç.
2. Sağ üstten **Geliştirici modu**nu aç.
3. **Paketlenmemiş öğe yükle** ile `extension/` klasörünü seç.
4. Popup'ta **Ayarlar → Sunucu adresi** kısmına sunucunun adresini yaz. Örnek: `wss://primecatparty.emreaka.net`. Yerelde denerken `ws://localhost:8080` kalabilir.

Eklentiyi güncelledikten sonra `chrome://extensions` sayfasından yenilemen yeterli. Açık Prime Video sekmelerine betik otomatik eklenir, sorun çıkarsa sekmeyi bir kez yenile.

## Kullanım

1. Popup'ta **Adın** alanına ismini yaz.
2. Prime Video'da izleyeceğiniz bölümü aç.
3. **Oda oluştur**'a bas, çıkan kodu **Kopyala** ile arkadaşına gönder.
4. Arkadaşın aynı bölümü açıp kodu yazar ve **Katıl**'a basar.
5. Artık ikiniz de normal şekilde izleyebilirsiniz; biri durdurunca ya da sarınca diğerinde de olur.

Eklenti ikonundaki rozet odadaki kişi sayısını gösterir. `…` bağlanıyor, `!` bağlantı kopuk demektir.

## Sunucu

### Yerelde

```bash
cd server
npm install
npm start          # ws://127.0.0.1:8080
```

| Değişken | Varsayılan | Açıklama |
| --- | --- | --- |
| `PORT` | `8080` | Dinlenen port |
| `HOST` | `127.0.0.1` | Dinlenen adres (Docker imajında `0.0.0.0`) |
| `LOG_LEVEL` | — | `debug` verilirse heartbeat ve ping'ler de loglanır |

Sunucu bağlantıları, odaları, odadakileri ve oynatma komutlarını loglar:

```
[22:54:03] #2 Barış (bbbbbbbb) f5213ce3 odasına katıldı
[22:54:03]   oda f5213ce3 [2/8]: #1 Emre (aaaaaaaa) (host), #2 Barış (bbbbbbbb)
[22:54:04] #2 Barış (bbbbbbbb) → f5213ce3: control pause @ 61.00 sn (duraklatıldı) (1 kişiye)
```

### Docker

```bash
cd server
docker build -t primecatparty-server .
docker run -d -p 8080:8080 primecatparty-server
```

### Docker Compose

```yaml
  primecatparty:
    image: ghcr.io/emreaka/primecatparty:latest
    container_name: primecatparty
    mem_limit: 256M
    restart: always
    expose:
      - 8080
    environment:
      - LOG_LEVEL=${PRIMECATPARTY_LOG_LEVEL:-info}
    healthcheck:
      test: ["CMD", "node", "-e", "require('net').connect(8080,'127.0.0.1').on('connect',()=>process.exit(0)).on('error',()=>process.exit(1))"]
      interval: 30s
      timeout: 5s
      retries: 3
      start_period: 10s
```

Sunucu odaları hafızada tutar, yeniden başlatılınca odalar sıfırlanır ve eklentiler kendiliğinden yeniden bağlanır. Bu yüzden volume gerekmez.

### Caddy

Caddy WebSocket upgrade'ini kendisi halleder:

```
primecatparty.emreaka.net {
    reverse_proxy primecatparty:8080
}
```

### Otomatik deploy

`main` dalına her push'ta `.github/workflows/docker.yml`:

1. `server/` klasöründen arm64 imajı build edip `ghcr.io/emreaka/primecatparty` olarak yükler (`latest` ve commit SHA etiketleriyle).
2. VPS'e SSH ile bağlanıp `docker compose pull` ve `up -d` ile `primecatparty` servisini günceller.

Gereken repo secret'ları: `VPS_HOST`, `VPS_USER`, `SSH_PRIVATE_KEY`.

## Protokol

Tüm mesajlar JSON'dur. `position` saniye cinsinden video konumu, `at` ise gönderenin sunucu saatine çevrilmiş zaman damgasıdır (ms).

| Yön | Mesaj | Alanlar |
| --- | --- | --- |
| → | `join` | `roomId`, `clientId`, `name` |
| ← | `joined` | `isHost`, `hostId`, `peers`, `members`, `state`, `t1` |
| ↔ | `ping` / `pong` | `t0`, `t1` |
| → | `control` | `action` (`play` / `pause` / `seek` / `rate`), `position`, `playing`, `rate`, `at`, `name` |
| ↔ | `heartbeat` | `position`, `playing`, `rate`, `at`, `fromHost` |
| → | `adBreak` | `active`, `name` |
| → | `buffering` | `active` |
| → | `contentChanged` | `contentId`, `duration`, `name` |
| → | `rename` | `name` |
| ← | `peerJoined` / `peerLeft` | `clientId`, `name`, `peers`, `hostId`, `members` |
| ← | `members` | `members`, `hostId` |

İstemcinin gönderdiği mesajlarda ayrıca `clientId` bulunur. Sunucu mesajları gönderen hariç odadakilere olduğu gibi iletir. Son `control` mesajını ve host'un son `heartbeat`'ini odanın durumu olarak saklar; geç katılana `joined` içinde bu durum gönderilir.

Sunucunun bağlantıyı kapatma kodları: `4000` geçersiz oda kodu veya istemci, `4001` oda dolu.

## Hata ayıklama

- **Popup → Hata ayıklama:** Her çerçeve için odanın sayfaya ulaşıp ulaşmadığını, bağlantı durumunu, sayfadaki `<video>`'ları, her birinin neden seçilip seçilmediğini ve son logları gösterir. **Bilgiyi kopyala** hepsini JSON olarak kopyalar.
- **Sayfa konsolu:** DevTools → Console'da `PrimeCatParty` diye filtrele.
- **Sayfadaki gösterge:** Bağlantı, kişiler, host'a göre fark ve RTT sol üstte görünür. **Ayarlar**'dan kapatılabilir.

Sık karşılaşılanlar:

| Belirti | Sebep |
| --- | --- |
| "Sayfa betiği çalışmıyor" | Sekme eklentiden önce açılmış. Sekmeyi yenile. |
| "Video bekleniyor" | Betik çalışıyor ama uygun video bulamadı. Hata ayıklama bölümünde videoların yanındaki sebebe bak. |
| "Yeniden bağlanıyor" | Sunucuya ulaşılamıyor. Sunucu adresini ve sunucunun çalıştığını kontrol et. |
| "Diğer taraf başka bir bölüm izliyor" | Bölümler farklı, senkron bilerek durduruldu. |

## Bilinen sınırlamalar

- Sadece `www.primevideo.com` üzerinde çalışır.
- İçerik kontrolü sadece URL'deki kimliğe bakar. Aynı sezonun bölümleri aynı URL'yi paylaşıyorsa farklı bölümde olmanız yakalanmaz. Süre karşılaştırması bilerek kullanılmıyor: Prime akışa reklam eklediği için aynı içerikte süreler kişiden kişiye farklı çıkabiliyor.
- Reklamlar süreden anlaşılıyor (bölüm uzunken 90 sn veya daha kısa video). 90 saniyeden uzun reklamlar reklam olarak algılanmaz.
- Oynatma ve durdurma Prime'ın kendi play/pause butonuna basılarak yapılıyor. Prime arayüzünü değiştirirse bu kısım güncellenmeli.
- Karşıdan gelen bir komut uygulandıktan sonraki 2,5 sn içinde senin bastığın play/pause karşıya gitmez, tekrar basman gerekir.
