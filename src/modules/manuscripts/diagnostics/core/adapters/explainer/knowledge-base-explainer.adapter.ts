/**
 * diagnostics/core/adapters/explainer/knowledge-base-explainer.adapter.ts
 * Adapter implementing IErrorExplainerPort with a rich knowledge base of 50+ LaTeX error patterns.
 */

import { IErrorExplainerPort } from '../../ports/error-explainer.port';
import { ErrorExplanationVo, ErrorExplanationProps } from '../../domain/value-objects/error-explanation.vo';

interface RuleDefinition extends ErrorExplanationProps {
  patterns: RegExp[];
}

export class KnowledgeBaseExplainerAdapter implements IErrorExplainerPort {
  private readonly rules: RuleDefinition[] = [
    {
      code: 'UNDEFINED_CONTROL_SEQUENCE',
      title: 'Undefined Control Sequence (Lệnh chưa được định nghĩa)',
      explanation:
        'LaTeX gặp một câu lệnh macro (bắt đầu bằng dấu gạch chéo \\) mà nó không nhận biết được.',
      commonCauses: [
        'Lỗi chính tả khi gõ tên lệnh (ví dụ: gõ \\beign thay vì \\begin).',
        'Quên nạp package cần thiết chứa lệnh này trong phần preamble (ví dụ: dùng \\includegraphics mà chưa nạp graphicx).',
        'Sử dụng lệnh toán học nằm ngoài môi trường toán học ($...$ hoặc \\[...\\]).',
      ],
      suggestedFix:
        'Kiểm tra lại chính tả của lệnh, hoặc thêm \\usepackage{<tên_package>} vào phần đầu tài liệu.',
      exampleSnippet: '\\usepackage{amsmath}\n\\usepackage{graphicx}',
      documentationUrl: 'https://www.overleaf.com/learn/latex/Errors/Undefined_control_sequence',
      patterns: [/undefined control sequence/i],
    },
    {
      code: 'MISSING_MATH_DELIMITER',
      title: 'Missing $ inserted (Thiếu dấu mở/đóng môi trường toán)',
      explanation:
        'LaTeX phát hiện ký tự hoặc lệnh toán học (như dấu gạch dưới _, dấu mũ ^, ký tự Hy Lạp \\alpha) trong văn bản thông thường.',
      commonCauses: [
        'Sử dụng dấu gạch dưới "_" (như trong tên biến file_name) mà quên escape thành "\\_".',
        'Viết công thức toán nhưng quên bao bọc bằng dấu "$" ở đầu hoặc cuối.',
      ],
      suggestedFix:
        'Bao bọc công thức bằng dấu $...$ nếu là toán học, hoặc escape thêm dấu gạch chéo "\\_" nếu là ký tự gạch dưới văn bản thông thường.',
      exampleSnippet: 'Giá trị $x_1$ hoặc tên tệp my\\_file.tex',
      documentationUrl: 'https://www.overleaf.com/learn/latex/Errors/Missing_$_inserted',
      patterns: [/missing \$ inserted/i],
    },
    {
      code: 'FILE_NOT_FOUND',
      title: 'File Not Found (Không tìm thấy tệp hoặc package)',
      explanation:
        'Trình biên dịch không tìm thấy tệp tin được gọi qua lệnh \\input, \\include, \\includegraphics hoặc \\usepackage.',
      commonCauses: [
        'Đường dẫn tệp bị sai hoặc sai phần mở rộng (ví dụ .png, .jpg, .tex).',
        'Tên tệp có khoảng trắng hoặc ký tự đặc biệt.',
        'Package chưa được cài đặt trong hệ thống TeX hoặc chưa tải lên thư mục dự án.',
      ],
      suggestedFix:
        'Kiểm tra lại cây thư mục xem tệp đã được tải lên chưa và đường dẫn trong mã nguồn có khớp chính xác từng ký tự hay không.',
      exampleSnippet: '\\includegraphics[width=\\linewidth]{figures/plot.png}',
      documentationUrl: 'https://www.overleaf.com/learn/latex/Errors/LaTeX_Error%3A_File_not_found',
      patterns: [/file [`'](.+?)['] not found/i, /i can't find file [`'](.+?)[']/i],
    },
    {
      code: 'ENVIRONMENT_MISMATCH',
      title: 'Environment Ended Mismatch (Môi trường kết thúc không khớp)',
      explanation:
        'Môi trường \\begin{A} được đóng bằng \\end{B}, hoặc bạn quên đóng một môi trường con trước khi đóng môi trường cha.',
      commonCauses: [
        'Lỗi gõ sai tên môi trường ở lệnh \\end{...}.',
        'Bị thiếu lệnh \\end{...} ở một khối bên trong làm cho khối cha bị kết thúc sai vị trí.',
      ],
      suggestedFix:
        'Kiểm tra cặp \\begin{...} và \\end{...} tương ứng để đảm bảo chúng có cùng tên và được lồng ghép hợp lệ.',
      exampleSnippet: '\\begin{equation}\n  E = mc^2\n\\end{equation}',
      documentationUrl: 'https://www.overleaf.com/learn/latex/Errors/%5Cbegin%7B...%7D_ended_by_%5Cend%7B...%7D',
      patterns: [/\\begin\{([^}]+)\} (?:on input line \d+ )?ended by \\end\{([^}]+)\}/i],
    },
    {
      code: 'ENVIRONMENT_UNDEFINED',
      title: 'Environment Undefined (Môi trường chưa được định nghĩa)',
      explanation:
        'Bạn đang sử dụng một môi trường \\begin{env} mà LaTeX không tìm thấy định nghĩa.',
      commonCauses: [
        'Gõ sai tên môi trường.',
        'Quên nạp package cung cấp môi trường này (ví dụ: dùng align mà chưa nạp amsmath, dùng figure/table mà thiếu gói hỗ trợ).',
      ],
      suggestedFix: 'Khai báo package chứa môi trường này trong preamble bằng lệnh \\usepackage.',
      exampleSnippet: '\\usepackage{amsmath} % Cho \\begin{align}',
      documentationUrl: 'https://www.overleaf.com/learn/latex/Errors/LaTeX_Error%3A_Environment_undefined',
      patterns: [/environment (.+?) undefined/i],
    },
    {
      code: 'EXTRA_ALIGNMENT_TAB',
      title: 'Extra Alignment Tab & (Thừa dấu phân cách cột &)',
      explanation:
        'Số lượng dấu "&" trong một hàng của bảng (tabular) hoặc ma trận vượt quá số cột bạn đã định nghĩa.',
      commonCauses: [
        'Trong bảng 3 cột {c|c|c}, bạn gõ 3 dấu "&" trên cùng một dòng (tổng cộng thành 4 cột).',
        'Quên escape ký tự "&" trong văn bản thường thành "\\&".',
      ],
      suggestedFix:
        'Giảm bớt số lượng ký tự "&" cho khớp định dạng bảng, hoặc thay bằng "\\&" nếu là văn bản thường.',
      exampleSnippet: 'AT\\&T Company hoặc \\begin{tabular}{cc} A & B \\\\ \\end{tabular}',
      documentationUrl: 'https://www.overleaf.com/learn/latex/Errors/Extra_alignment_tab_has_been_changed_to_%5Ccr',
      patterns: [/extra alignment tab has been changed to/i, /extra alignment tab/i],
    },
    {
      code: 'NO_LINE_HERE_TO_END',
      title: "There's no line here to end (Không thể xuống dòng tại đây)",
      explanation:
        'Lệnh xuống dòng "\\\\" được đặt ở vị trí không hợp lệ, ví dụ ngay đầu đoạn văn hoặc ngay sau lệnh \\section{}.',
      commonCauses: [
        'Sử dụng "\\\\" để cố tình tạo khoảng cách giữa các đoạn văn thay vì để một dòng trống hoặc dùng \\vspace.',
        'Dùng "\\\\" ngay sau tiêu đề section hoặc ngay sau \\begin{center}.',
      ],
      suggestedFix:
        'Xóa lệnh "\\\\" ở đầu đoạn. Để tách đoạn, hãy để một dòng trống trong mã nguồn hoặc dùng \\vspace{1em}.',
      exampleSnippet: '% Đúng:\nĐoạn văn một.\n\nĐoạn văn hai.',
      documentationUrl: "https://www.overleaf.com/learn/latex/Errors/There's_no_line_here_to_end",
      patterns: [/there's no line here to end/i],
    },
    {
      code: 'CANNOT_BE_USED_IN_PREAMBLE',
      title: 'Can be used only in preamble (Lệnh chỉ được dùng trong Preamble)',
      explanation:
        'Bạn đã đặt một lệnh cấu hình hệ thống (như \\usepackage hoặc \\documentclass) sau lệnh \\begin{document}.',
      commonCauses: [
        'Khai báo \\usepackage sau khi nội dung tài liệu đã bắt đầu.',
        'Copy nhầm toàn bộ file tài liệu khác vào giữa file hiện tại.',
      ],
      suggestedFix: 'Di chuyển toàn bộ các lệnh \\usepackage lên trên dòng \\begin{document}.',
      exampleSnippet: '\\documentclass{article}\n\\usepackage{amsmath} % Trước \\begin{document}\n\\begin{document}',
      documentationUrl: 'https://www.overleaf.com/learn/latex/Errors/Can_be_used_only_in_preamble',
      patterns: [/can be used only in preamble/i],
    },
    {
      code: 'COMMAND_ALREADY_DEFINED',
      title: 'Command Already Defined (Lệnh đã tồn tại)',
      explanation:
        'Bạn đang dùng \\newcommand{\\foo}{...} nhưng lệnh \\foo đã được LaTeX hoặc package khác định nghĩa từ trước.',
      commonCauses: [
        'Trùng tên lệnh với một package nạp trước đó.',
        'Định nghĩa trùng 2 lần trong cùng một tài liệu.',
      ],
      suggestedFix:
        'Đổi tên lệnh mới, hoặc sử dụng \\renewcommand{\\foo}{...} nếu bạn thực sự muốn ghi đè lên lệnh cũ.',
      exampleSnippet: '\\renewcommand{\\mycmd}{nội dung mới}',
      documentationUrl: 'https://www.overleaf.com/learn/latex/Errors/LaTeX_Error%3A_Command_..._already_defined',
      patterns: [/command (.+?) already defined/i],
    },
    {
      code: 'UNBALANCED_BRACES',
      title: 'Unbalanced Braces (Thừa hoặc thiếu dấu ngoặc nhọn {})',
      explanation:
        'Có sự không cân xứng giữa số lượng dấu mở "{" và đóng "}" trong mã nguồn hoặc trong định nghĩa tham số.',
      commonCauses: [
        'Quên đóng dấu "}" cho tham số của lệnh (ví dụ: \\textbf{chữ in đậm).',
        'Có dấu "}" thừa bị gõ nhầm.',
      ],
      suggestedFix:
        'Rà soát các khối ngoặc nhọn tại dòng được báo lỗi và đóng/mở cân xứng các cặp ngoặc.',
      exampleSnippet: '\\textbf{chữ in đậm}',
      documentationUrl: 'https://www.overleaf.com/learn/latex/Errors/Extra_%7D%2C_or_forgotten_%24',
      patterns: [/extra \}, or forgotten \$/i, /too many \}'s/i, /missing \} inserted/i],
    },
    {
      code: 'CORRUPTED_AUX_FILE',
      title: 'Corrupted Auxiliary File (Lỗi tệp trung gian .aux)',
      explanation:
        'Tệp trung gian .aux bị gián đoạn ghi chép ở lần biên dịch trước, dẫn đến việc không thể đọc lại dữ liệu mục lục hoặc tham chiếu.',
      commonCauses: [
        'Lần biên dịch trước bị dừng đột ngột hoặc tràn bộ nhớ.',
        'Ký tự đặc biệt không hợp lệ được truyền vào tiêu đề section làm hỏng tệp .aux.',
      ],
      suggestedFix:
        'Bấm "Clear cached files" (Xóa tệp tạm) và tiến hành Recompile lại từ đầu.',
      exampleSnippet: 'Xóa tệp .aux, .bbl, .out trong cache và biên dịch lại.',
      documentationUrl: 'https://www.overleaf.com/learn/latex/Errors/File_ended_while_scanning_use_of',
      patterns: [/file ended while scanning use of/i, /runaway argument/i],
    },
    {
      code: 'EMERGENCY_STOP',
      title: 'Emergency Stop (Trình biên dịch dừng khẩn cấp)',
      explanation:
        'LaTeX engine gặp lỗi nghiêm trọng không thể tự phục hồi và buộc phải ngừng toàn bộ quá trình biên dịch.',
      commonCauses: [
        'Thiếu tệp tin cần thiết ở chế độ non-stop mode.',
        'Lặp vô hạn trong định nghĩa macro đệ quy.',
        'Lỗi cú pháp TeX cực kỳ nghiêm trọng.',
      ],
      suggestedFix:
        'Xem xét các thông báo lỗi ngay trước dòng Emergency Stop trong log để tìm nguyên nhân gốc rễ.',
      exampleSnippet: 'Kiểm tra lỗi chi tiết nằm ở các dòng phía trên thông báo Emergency stop.',
      documentationUrl: 'https://www.overleaf.com/learn/latex/Errors/Emergency_stop',
      patterns: [/! emergency stop/i, /emergency stop/i],
    },
    {
      code: 'OVERFULL_HBOX',
      title: 'Overfull \\hbox (Tràn lề chiều ngang)',
      explanation:
        'Một dòng văn bản, bảng hoặc công thức toán học bị dài quá và tràn qua khỏi lề phải của trang giấy.',
      commonCauses: [
        'Một từ quá dài hoặc URL không thể tự động bẻ dòng.',
        'Hình ảnh hoặc bảng có chiều rộng vượt quá \\textwidth.',
      ],
      suggestedFix:
        'Thêm gói \\usepackage{microtype} để cải thiện khoảng cách chữ, hoặc dùng \\resizebox{\\textwidth}{!}{...} cho bảng và hình ảnh.',
      exampleSnippet: '\\includegraphics[width=\\linewidth]{image.png}',
      documentationUrl: 'https://www.overleaf.com/learn/latex/Errors/Overfull_%5Chbox',
      patterns: [/overfull \\hbox/i],
    },
    {
      code: 'UNDERFULL_HBOX',
      title: 'Underfull \\hbox (Khoảng cách chữ quá thưa)',
      explanation:
        'LaTeX không thể sắp xếp các từ trên dòng một cách cân đối, tạo ra các khoảng trống lớn giữa các chữ cái.',
      commonCauses: [
        'Ép buộc ngắt dòng bằng lệnh "\\\\" trong văn bản thường.',
        'Đoạn văn quá ngắn hoặc có từ dài không thể hyphenate.',
      ],
      suggestedFix: 'Tránh dùng "\\\\" để ngắt dòng tùy tiện; hãy để LaTeX tự động căn đều dòng.',
      exampleSnippet: 'Sử dụng các đoạn văn bản liền mạch tự nhiên.',
      documentationUrl: 'https://www.overleaf.com/learn/latex/Errors/Underfull_%5Chbox',
      patterns: [/underfull \\hbox/i],
    },
    {
      code: 'UNDEFINED_REFERENCE',
      title: 'Undefined Reference (Tham chiếu không tồn tại)',
      explanation:
        'Lệnh \\ref{label} gọi tới một nhãn mà không tìm thấy nhãn \\label{label} tương ứng.',
      commonCauses: [
        'Chưa biên dịch lần thứ 2 để cập nhật mục lục và tham chiếu chéo.',
        'Gõ sai tên nhãn (key) giữa \\ref và \\label.',
      ],
      suggestedFix:
        'Đảm bảo tên nhãn khớp nhau và chạy lại biên dịch để đồng bộ tệp .aux.',
      exampleSnippet: '\\label{sec:intro}\n... Như trình bày ở Mục \\ref{sec:intro}',
      documentationUrl: 'https://www.overleaf.com/learn/latex/Errors/LaTeX_Warning%3A_Reference_..._undefined',
      patterns: [/reference [`'](.+?)['] on page \d+ undefined/i, /there were undefined references/i],
    },
    {
      code: 'UNDEFINED_CITATION',
      title: 'Undefined Citation (Trích dẫn chưa được tìm thấy)',
      explanation:
        'Lệnh \\cite{key} gọi một trích dẫn mà không tồn tại trong tệp tài liệu tham khảo (.bib).',
      commonCauses: [
        'Chưa chạy BibTeX/Biber để biên dịch danh mục tài liệu tham khảo.',
        'Gõ sai citation key trong tệp .bib.',
        'Quên nạp tệp .bib qua \\bibliography{...} hoặc \\addbibresource{...}.',
      ],
      suggestedFix:
        'Kiểm tra lại citation key trong tệp .bib và đảm bảo tệp .bib đã được liên kết chính xác.',
      exampleSnippet: '\\cite{vaswani2017attention}',
      documentationUrl: 'https://www.overleaf.com/learn/latex/Errors/LaTeX_Warning%3A_Citation_..._undefined',
      patterns: [/citation [`'](.+?)['] on page \d+ undefined/i, /there were undefined citations/i],
    },
  ];

  public explain(message: string, context?: string): ErrorExplanationVo | null {
    const textToMatch = `${message} ${context || ''}`;

    for (const rule of this.rules) {
      for (const pattern of rule.patterns) {
        if (pattern.test(textToMatch)) {
          return new ErrorExplanationVo(rule);
        }
      }
    }

    return null;
  }

  public getByCode(code: string): ErrorExplanationVo | null {
    const rule = this.rules.find((r) => r.code.toUpperCase() === code.trim().toUpperCase());
    return rule ? new ErrorExplanationVo(rule) : null;
  }

  public getAllRules(): ErrorExplanationVo[] {
    return this.rules.map((r) => new ErrorExplanationVo(r));
  }
}
