"""
Convert markdown files to a single Word document
"""
from docx import Document
from docx.shared import Pt, Inches, RGBColor
from docx.enum.text import WD_PARAGRAPH_ALIGNMENT
import re

def add_markdown_to_doc(doc, md_file_path):
    """Read markdown file and add to document with basic formatting"""

    with open(md_file_path, 'r', encoding='utf-8') as f:
        content = f.read()

    lines = content.split('\n')
    in_code_block = False
    code_lang = ''

    for line in lines:
        # Check for code blocks
        if line.startswith('```'):
            in_code_block = not in_code_block
            if in_code_block:
                code_lang = line[3:].strip()
            continue

        if in_code_block:
            # Code block
            p = doc.add_paragraph(line, style='Intense Quote')
            p.paragraph_format.space_before = Pt(0)
            p.paragraph_format.space_after = Pt(0)
            for run in p.runs:
                run.font.name = 'Consolas'
                run.font.size = Pt(9)
        elif line.startswith('# '):
            # Heading 1
            p = doc.add_heading(line[2:], level=1)
        elif line.startswith('## '):
            # Heading 2
            p = doc.add_heading(line[3:], level=2)
        elif line.startswith('### '):
            # Heading 3
            p = doc.add_heading(line[4:], level=3)
        elif line.startswith('#### '):
            # Heading 4
            p = doc.add_heading(line[5:], level=4)
        elif line.startswith('---'):
            # Horizontal line
            p = doc.add_paragraph()
            p.add_run('_' * 80)
        elif line.strip().startswith('- ') or line.strip().startswith('* '):
            # Bullet point
            text = line.strip()[2:]
            p = doc.add_paragraph(text, style='List Bullet')
        elif re.match(r'^\d+\. ', line.strip()):
            # Numbered list
            text = re.sub(r'^\d+\. ', '', line.strip())
            p = doc.add_paragraph(text, style='List Number')
        elif line.strip() == '':
            # Empty line
            doc.add_paragraph()
        else:
            # Regular paragraph
            # Handle bold and italic
            p = doc.add_paragraph()

            # Simple bold handling: **text**
            parts = re.split(r'(\*\*[^*]+\*\*)', line)
            for part in parts:
                if part.startswith('**') and part.endswith('**'):
                    run = p.add_run(part[2:-2])
                    run.bold = True
                else:
                    # Handle inline code: `code`
                    code_parts = re.split(r'(`[^`]+`)', part)
                    for code_part in code_parts:
                        if code_part.startswith('`') and code_part.endswith('`'):
                            run = p.add_run(code_part[1:-1])
                            run.font.name = 'Consolas'
                            run.font.size = Pt(9)
                        else:
                            p.add_run(code_part)

# Create document
doc = Document()

# Set default font
style = doc.styles['Normal']
font = style.font
font.name = 'Calibri'
font.size = Pt(11)

# Add title
title = doc.add_heading('GAM Coach Check Feature - Complete Walkthrough', 0)
title.alignment = WD_PARAGRAPH_ALIGNMENT.CENTER

# Add subtitle
subtitle = doc.add_paragraph('Detailed Step-by-Step Explanation')
subtitle.alignment = WD_PARAGRAPH_ALIGNMENT.CENTER
subtitle.runs[0].font.size = Pt(14)
subtitle.runs[0].italic = True

doc.add_paragraph()

# Add Part 1
print("Adding Part 1 (Steps 1-8)...")
part1_heading = doc.add_heading('Part 1: Form Initialization and Sample Building', 1)
part1_heading.runs[0].font.color.rgb = RGBColor(0, 51, 153)

add_markdown_to_doc(doc, 'CHECK_FEATURE_DETAILED_WALKTHROUGH.md')

# Add page break
doc.add_page_break()

# Add Part 2
print("Adding Part 2 (Steps 9-14)...")
part2_heading = doc.add_heading('Part 2: EBM Prediction Calculations', 1)
part2_heading.runs[0].font.color.rgb = RGBColor(0, 51, 153)

add_markdown_to_doc(doc, 'CHECK_FEATURE_DETAILED_WALKTHROUGH_PART2.md')

# Save document
output_file = 'GAM_Coach_Check_Feature_Complete_Walkthrough.docx'
doc.save(output_file)
print(f"\n[OK] Document saved as: {output_file}")
print(f"  Location: D:\\OSU\\Dr B research group\\GAM_Coach\\gam-coach_modified\\{output_file}")
