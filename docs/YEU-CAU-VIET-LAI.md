# Yêu cầu viết lại VN Stock Advisor cho "chuẩn"

Phiên bản 1 · 26/10/2026 · lập từ những gì đã quan sát khi chạy tool thật từ 16/10/2026.

## 0. Thế nào là "chuẩn"

Tool chuẩn không có nghĩa là đoán trúng mọi phiên. Chuẩn nghĩa là **4 điều sau đều đo được và đạt**:

| # | Tiêu chí | Đo bằng | Ngưỡng đạt |
|---|---|---|---|
| C1 | **Dữ liệu đúng** | Kiểm tra tự động mỗi ngày | 0 nến tạm / nến chưa chốt trong dữ liệu chấm điểm; mọi bất thường (giá ghim, sàn liên tiếp, khối lượng 0) bị gắn cờ |
| C2 | **Chỉ khuyên MUA khi có lợi thế đã kiểm chứng** | Kiểm định ngoài mẫu (walk-forward) 2023→nay | Nhóm MUA hơn rổ đồng tỷ trọng sau 20 phiên ở ≥ 2/3 số nửa năm, kể cả giai đoạn VN-Index dưới MA200. Không đạt trong chế độ thị trường nào thì chế độ đó **không phát tín hiệu MUA** |
| C3 | **Mọi dự đoán đều được ghi và tự chấm** bằng một thước đo duy nhất | Bảng chấm trong database | 100% khuyến nghị, dải giá, xếp ưu tiên, triển vọng tuần có điểm sau 5/10/20 phiên |
| C4 | **Cảnh báo đến kịp và không mất** | Nhật ký gửi | Cảnh báo danh mục ≤ 5 phút sau khi giá chạm ngưỡng; 0 tin mất do lỗi mạng (có hàng đợi gửi lại) |

Mọi thay đổi về sau phải nói rõ nó cải thiện tiêu chí nào và bằng số liệu nào.

## 1. Hiện trạng và vấn đề (bằng chứng thực tế)

| Vấn đề | Bằng chứng | Hậu quả |
|---|---|---|
| Dữ liệu bị lẫn nến chưa chốt | 22/10: database lưu nến 9h30 làm giá đóng cửa (VN-Index 1749 thay vì 1760,63) | Chấm điểm, chẩn đoán sai cả ngày (đã vá tạm) |
| Mã bị ghim giá vẫn được khuyên mua | NAF biên độ 0,8%/20 phiên được "CÂN NHẮC MUA" 3 ngày | Gợi ý vô dụng (đã vá tạm) |
| Nhóm MUA chưa chứng minh được lợi thế | 16–21/10: nhóm MUA kém rổ 2–4% sau 5 phiên, nhóm TRÁNH hơn rổ +2,5% | Người dùng mất tin tưởng; chưa biết là xui hay sai |
| So với VN-Index làm méo kết quả | 21–23/10 VN-Index tăng nhờ VIC/VHM/VRE (+10%) trong khi cổ phiếu trung vị đứng giá | Kết luận sai về độ chính xác (đã thêm thước đo rổ, nhưng còn chỗ dùng VN-Index) |
| Hai nguồn dữ liệu song song | JSON trong `data/` là nguồn chính, PostgreSQL chỉ là bản sao 10 phút/lần | Ba cách chấm điểm khác nhau (predictions.js, selfreview.js, view SQL) có thể cho số khác nhau |
| Nhiều lớp AI chồng nhau, chưa đo giá trị | Mỗi mã: Gemini → hội đồng → gộp quyết định → AI xếp ưu tiên; cùng dữ liệu, xếp NT2 lúc "đầu cơ" lúc "có thể mua" | Tốn hạn mức, chậm, kết quả dao động mà không biết lớp nào giúp ích |
| ~18 bộ hẹn giờ rời rạc ở 13 file | Mỗi module tự `setInterval` và tự kiểm tra giờ; chỉ một số biết ngày lễ | Khó biết việc gì chạy lúc nào; lỗi giờ (như 22/10) khó phát hiện |
| Giao diện một file khổng lồ | `public/app.js` 3.100 dòng | Sửa một chỗ dễ hỏng chỗ khác |
| Kết nối Telegram chập chờn | Hàng trăm lỗi "fetch failed" mỗi ngày, có lúc ETIMEDOUT | Có thể mất cảnh báo (đã thêm gửi lại 2 lần, chưa có hàng đợi) |
| Chưa rõ giá đã điều chỉnh cổ tức/chia tách chưa | Chưa có kiểm tra | Chỉ báo kỹ thuật và chấm điểm có thể sai quanh ngày GDKHQ |

## 2. Yêu cầu chức năng

### 2.1 Dữ liệu (nền móng – làm trước tiên)
- D1. **Một nguồn sự thật duy nhất: PostgreSQL.** JSON chỉ còn cho cấu hình; mọi giá, dự đoán, kết quả AI, giao dịch ghi thẳng vào database.
- D2. **Lịch giao dịch** (ngày lễ HOSE, phiên sáng/chiều, ATO/ATC) dùng chung cho mọi module. Phân biệt rõ "nến đang chạy" và "nến đã chốt"; chỉ nến đã chốt (sau 15:05 và đã xác nhận khối lượng) mới vào bảng giá ngày.
- D3. **Kiểm tra chất lượng tự động mỗi ngày**: nến trùng/thiếu, khối lượng 0, high = low, nhảy giá > biên độ sàn (dấu hiệu chưa điều chỉnh), giá ghim, mã ngừng giao dịch → gắn cờ và loại khỏi tín hiệu.
- D4. **Giá điều chỉnh** theo cổ tức tiền/cổ phiếu, chia tách: xác minh nguồn, nếu nguồn không điều chỉnh thì tự điều chỉnh từ lịch sự kiện doanh nghiệp.
- D5. Lưu **ảnh chụp đầu vào** của mỗi quyết định (các chỉ báo, điểm, tin tức đưa cho AI) để tái hiện được vì sao tool đã khuyên như vậy.

### 2.2 Tín hiệu và xếp hạng
- S1. **Thước đo duy nhất**: lãi hơn **rổ đồng tỷ trọng** sau 5/10/20 phiên (VN-Index chỉ để tham khảo).
- S2. **Nhận diện chế độ thị trường** (VN-Index trên/dưới MA200, độ rộng thị trường, biến động) là đầu vào bắt buộc của xếp hạng. Mỗi chế độ có bộ tham số và **chỉ phát tín hiệu khi chế độ đó đã đạt C2**.
- S3. **Khung nghiên cứu tái lập được**: script backtest walk-forward trên dữ liệu trong database, kết quả lưu bảng, có phí, thuế, T+2, trần/sàn, trượt giá (đã có trong backtest.js – tái sử dụng). Mọi thay đổi trọng số phải chạy qua khung này trước.
- S4. **Giám sát yếu tố**: IC từng yếu tố theo thời gian (đã có view `factor_ic`); yếu tố đổi chiều liên tục 20 phiên thì cảnh báo.
- S5. Bộ lọc loại mã (rác, ghim giá, thanh khoản, lời kỳ vọng < 4%) là **một hàm duy nhất** dùng cho web, bản tin, radar.

### 2.3 AI
- A1. **Mỗi lớp AI phải chứng minh giá trị** so với không dùng nó (cùng mã, cùng ngày): lớp nào sau ≥ 60 mẫu 10 phiên không cải thiện tỷ lệ đúng so rổ thì tắt hoặc chỉ để giải thích, không được đổi quyết định.
- A2. **Giảm số lần gọi**: một lần phân tích mỗi mã mỗi phiên (gộp Gemini + hội đồng thành một bước có cấu trúc), một lần so sánh danh sách. Có cache theo (mã, phiên, dữ liệu đầu vào).
- A3. **AI không được bịa số**: mọi con số trong lý do phải khớp dữ liệu đầu vào (kiểm tra tự động), mức giá phải nằm trong dải thống kê.
- A4. **Ổn định**: cùng đầu vào chạy 2 lần phải ra cùng nhóm ở ≥ 80% số mã; nếu không, dùng nhiệt độ thấp hoặc bỏ phiếu đa số.

### 2.4 Quyết định và quản lý vốn
- Q1. Người dùng khai báo **vốn, khẩu vị rủi ro, số mã tối đa, thời gian nắm giữ**; mọi tỷ trọng tính ra **số cổ phiếu cụ thể** (lô 100), không chỉ %.
- Q2. Rủi ro mỗi lệnh ≤ X% vốn (mặc định 1%): khối lượng = rủi ro ÷ khoảng cách tới cắt lỗ.
- Q3. Giới hạn tập trung: tối đa 2 mã/ngành, tổng giải ngân theo chế độ thị trường.
- Q4. Mỗi khuyến nghị có **một hành động rõ ràng**: MUA NGAY x cp giá ≤ y / ĐẶT MUA x cp ở y / CHỜ / BÁN x cp. Không dùng các nhãn mơ hồ chồng nhau (NÊN MUA, CÂN NHẮC MUA, MUA THĂM DÒ…).

### 2.5 Cảnh báo và thông báo
- N1. **Hàng đợi gửi tin** lưu trong database: tin chưa gửi được thì thử lại đến khi thành công, báo trễ bao nhiêu phút.
- N2. Kênh dự phòng khi Telegram không vào được (email hoặc thông báo trên web/điện thoại qua Tailscale).
- N3. Mức độ: 🔴 cần làm ngay (thủng cắt lỗ) gửi ngay; 🟡 thông tin (tăng/giảm mạnh) gộp theo 15 phút; bản tin 2 lần/ngày giữ nguyên.
- N4. Giới hạn số tin/ngày và tắt tiếng theo khung giờ do người dùng chọn.

### 2.6 Đánh giá và tự cải thiện
- E1. Một bảng chấm duy nhất trong database cho mọi loại dự đoán (bỏ chấm trong JSON).
- E2. **Báo cáo tuần** (thứ 7): tỷ lệ đúng so rổ của từng nguồn, theo chế độ thị trường, kèm khoảng tin cậy; nói rõ "chưa đủ mẫu" khi chưa đủ.
- E3. Tự chỉnh thông số chỉ trong biên an toàn (như selfreview hiện nay); thay đổi logic tín hiệu luôn cần người duyệt.

### 2.7 Giao diện
- U1. Trang chính trả lời 3 câu: *Hôm nay mua gì, bao nhiêu? Mã đang giữ cần làm gì? Tool gần đây đúng bao nhiêu?*
- U2. Tách `app.js` thành các module theo trang; dùng trên điện thoại được.

## 3. Yêu cầu phi chức năng
- Kiến trúc: `data` (lấy + làm sạch) → `signals` (xếp hạng thuần, không gọi mạng) → `ai` → `decision` → `notify`; các lớp chỉ gọi lớp dưới.
- **Một bộ lập lịch** dựa trên lịch giao dịch, mỗi tác vụ có nhật ký chạy (bắt đầu, kết thúc, lỗi) trong database.
- Cấu hình tập trung một file, có kiểm tra khi khởi động.
- Kiểm thử: giữ unit test hiện có (126); thêm test tích hợp với dữ liệu mẫu cố định (một tuần giá thật) chạy toàn bộ luồng từ dữ liệu → bản tin.
- Theo dõi sức khỏe: trang /health cho biết lần chạy gần nhất của từng tác vụ, độ trễ dữ liệu, lỗi gửi tin.

## 4. Lộ trình (sửa dần từng phần, không viết lại một lần)

Tool đang chạy hằng ngày nên **thay từng phần**, mỗi giai đoạn chạy song song bản cũ ít nhất 1 tuần rồi mới tắt bản cũ.

| Giai đoạn | Nội dung | Xong khi |
|---|---|---|
| **P0 · Nền dữ liệu** (≈ 1 tuần) | D1–D3, lịch giao dịch, bộ lập lịch chung, hàng đợi gửi tin N1 | C1 và C4 đạt 5 phiên liền |
| **P1 · Thước đo + nghiên cứu** (≈ 1 tuần) | S1, S3, E1, E2; chạy lại nghiên cứu xếp hạng theo chế độ thị trường | Có bảng kết quả walk-forward theo từng chế độ |
| **P2 · Tín hiệu theo chế độ** | S2, S5 dựa trên kết quả P1 | Tín hiệu MUA chỉ phát ở chế độ đạt C2 |
| **P3 · AI gọn lại** | A1–A4, gộp các lớp AI | Số lần gọi AI giảm ≥ 50%, độ ổn định ≥ 80% |
| **P4 · Quyết định + vốn** | Q1–Q4 | Bản tin ghi số cổ phiếu cụ thể theo vốn khai báo |
| **P5 · Giao diện + vận hành** | U1–U2, N2–N4, /health | Trang chính trả lời đủ 3 câu |

## 5. Không làm
- Không hứa tỷ lệ thắng; không tự đặt lệnh qua công ty chứng khoán.
- Không thêm chỉ báo/AI mới trước khi P1 cho biết cái đang có hoạt động ra sao.
- Không đổi luật tín hiệu dựa trên dưới 20 phiên dữ liệu thật.

## 6. Cần người dùng quyết định
1. Vốn dự kiến dùng cho tool và mức lỗ tối đa chấp nhận mỗi lệnh (đề xuất 1% vốn).
2. Thời gian nắm giữ mong muốn: lướt vài phiên hay 1–2 tháng? (tín hiệu hiện tại thiết kế cho ~20 phiên)
3. Số mã tối đa muốn giữ cùng lúc.
4. Có chấp nhận tool **im lặng không khuyên mua** khi thị trường ở chế độ chưa có lợi thế không?
5. Kênh dự phòng khi Telegram lỗi: email hay thông báo qua web?
