import { Form1040Data, W2ToForm1040Mapping } from './form-1040-types';

export class W2ToForm1040Mapper {
  /**
   * Maps W2 extracted data to Form 1040 fields
   */
  static mapW2ToForm1040(w2Data: any, existingForm1040?: Partial<Form1040Data>): Partial<Form1040Data> {
    console.log('🔍 [W2 MAPPER] Starting W2 to 1040 mapping...');
    if (process.env.NODE_ENV === 'development') {
      console.log('🔍 [W2 MAPPER] Input w2Data structure:', JSON.stringify(w2Data, null, 2));
      console.log('🔍 [W2 MAPPER] Existing form1040 data:', JSON.stringify(existingForm1040, null, 2));
    }

    const form1040Data: Partial<Form1040Data> = {
      ...existingForm1040,
    };

    // Handle nested data structures - the data might be nested under extractedData
    let actualW2Data = w2Data;
    if (w2Data.extractedData && typeof w2Data.extractedData === 'object') {
      console.log('🔍 [W2 MAPPER] Found nested extractedData, using that instead');
      actualW2Data = w2Data.extractedData;
    }

    console.log('🔍 [W2 MAPPER] Using actualW2Data:', JSON.stringify(actualW2Data, null, 2));

    // Personal Information Mapping - Enhanced to prioritize W2 data
    console.log('🔍 [W2 MAPPER] Starting personal information mapping...');
    
    const employeeName = actualW2Data.employeeName || actualW2Data.Employee?.Name || actualW2Data['Employee.Name'];
    if (employeeName) {
      console.log('🔍 [W2 MAPPER] Mapping employee name from W2:', employeeName);
      const nameParts = employeeName.trim().split(/\s+/);
      // Always use W2 data for personal info, overriding any existing data
      form1040Data.firstName = nameParts[0] || '';
      form1040Data.lastName = nameParts.slice(1).join(' ') || '';
      console.log('✅ [W2 MAPPER] Mapped name - First:', form1040Data.firstName, 'Last:', form1040Data.lastName);
    }

    const employeeSSN = actualW2Data.employeeSSN || actualW2Data.Employee?.SSN || actualW2Data['Employee.SSN'];
    if (employeeSSN) {
      console.log('🔍 [W2 MAPPER] Mapping employee SSN from W2:', employeeSSN);
      // Always use W2 data for SSN, overriding any existing data
      form1040Data.ssn = this.formatSSN(employeeSSN);
      console.log('✅ [W2 MAPPER] Mapped SSN:', form1040Data.ssn);
    }

    // Enhanced address mapping - use pre-parsed components if available, otherwise parse full address
    const employeeAddress = actualW2Data.employeeAddress || actualW2Data.Employee?.Address || actualW2Data['Employee.Address'];
    
    // Check if address components are already parsed by Azure DI service
    if (actualW2Data.employeeAddressStreet || actualW2Data.employeeCity || actualW2Data.employeeState || actualW2Data.employeeZipCode) {
      console.log('🔍 [W2 MAPPER] Using pre-parsed address components from Azure DI service');
      form1040Data.address = actualW2Data.employeeAddressStreet || '';
      form1040Data.city = actualW2Data.employeeCity || '';
      form1040Data.state = actualW2Data.employeeState || '';
      form1040Data.zipCode = actualW2Data.employeeZipCode || '';
      console.log('✅ [W2 MAPPER] Mapped pre-parsed address:', {
        street: form1040Data.address,
        city: form1040Data.city,
        state: form1040Data.state,
        zipCode: form1040Data.zipCode
      });
    } else if (employeeAddress) {
      console.log('🔍 [W2 MAPPER] Parsing employee address from W2:', employeeAddress);
      const addressParts = this.parseAddress(employeeAddress);
      // Always use W2 data for address, overriding any existing data
      form1040Data.address = addressParts.street;
      form1040Data.city = addressParts.city;
      form1040Data.state = addressParts.state;
      form1040Data.zipCode = addressParts.zipCode;
      console.log('✅ [W2 MAPPER] Mapped parsed address:', {
        street: form1040Data.address,
        city: form1040Data.city,
        state: form1040Data.state,
        zipCode: form1040Data.zipCode
      });
    }

    // Universal OCR fallback for missing employee information
    if ((!employeeName || !employeeAddress) && actualW2Data.fullText) {
      console.log('🔍 [W2 MAPPER] Employee info missing, attempting universal OCR extraction...');
      const employeeInfo = this.extractEmployeeInfoFromOCR(actualW2Data.fullText);
      
      if (!employeeName && employeeInfo.name) {
        const nameParts = employeeInfo.name.trim().split(/\s+/);
        form1040Data.firstName = nameParts[0] || '';
        form1040Data.lastName = nameParts.slice(1).join(' ') || '';
        console.log('✅ [W2 MAPPER] Extracted employee name from OCR:', employeeInfo.name);
      }
      
      if (!employeeAddress && employeeInfo.address) {
        const addressParts = this.parseAddress(employeeInfo.address);
        form1040Data.address = addressParts.street;
        form1040Data.city = addressParts.city;
        form1040Data.state = addressParts.state;
        form1040Data.zipCode = addressParts.zipCode;
        console.log('✅ [W2 MAPPER] Extracted employee address from OCR:', employeeInfo.address);
      }
    }

    // Universal OCR fallback for missing employer information
    if (actualW2Data.fullText) {
      const employerInfo = this.extractEmployerInfoFromOCR(actualW2Data.fullText);
      
      // Store employer information in the form data for reference
      if (employerInfo.name || employerInfo.address || employerInfo.ein) {
        form1040Data.employerInfo = {
          name: employerInfo.name || actualW2Data.employerName || '',
          address: employerInfo.address || actualW2Data.employerAddress || '',
          ein: employerInfo.ein || actualW2Data.employerEIN || ''
        };
        console.log('✅ [W2 MAPPER] Extracted employer info from OCR:', form1040Data.employerInfo);
      }
    }

    // Create personal info object for easy access
    const personalInfo = {
      firstName: form1040Data.firstName ?? '',
      lastName: form1040Data.lastName ?? '',
      ssn: form1040Data.ssn ?? '',
      address: form1040Data.address ?? '',
      city: form1040Data.city ?? '',
      state: form1040Data.state ?? '',
      zipCode: form1040Data.zipCode ?? '',
      sourceDocument: 'W2',
      sourceDocumentId: String(actualW2Data.documentId || 'unknown')
    };

    // Add personal info to the form data for easy access by frontend
    form1040Data.personalInfo = personalInfo;
    console.log('✅ [W2 MAPPER] Created personalInfo object:', personalInfo);

    // Income Mapping - try multiple possible field names
    // Line 1: Total amount from Form(s) W-2, box 1
    const wagesValue = actualW2Data.wages || actualW2Data.WagesAndTips || actualW2Data['WagesAndTips'] || 
                      actualW2Data.box1 || actualW2Data.Box1 || actualW2Data['Box 1'] || 
                      actualW2Data.wagesAndTips || actualW2Data['wages_and_tips'];
    
    console.log('🔍 [W2 MAPPER] Found wages value:', wagesValue, 'type:', typeof wagesValue);
    let wages = this.parseAmount(wagesValue);
    console.log('🔍 [W2 MAPPER] Parsed wages amount:', wages);
    
    // OCR fallback if wages still not found
    if (wages === 0 && actualW2Data.fullText) {
      console.log('🔍 [W2 MAPPER] Wages not found in structured data, attempting OCR extraction...');
      wages = this.extractWagesFromOCR(actualW2Data.fullText);
      if (wages > 0) {
        console.log('✅ [W2 MAPPER] Successfully extracted wages from OCR:', wages);
      }
    }
    
    if (wages > 0) {
      form1040Data.line1 = (form1040Data.line1 || 0) + wages;
      console.log('✅ [W2 MAPPER] Successfully mapped wages to Line 1:', form1040Data.line1);
    } else {
      console.log('⚠️ [W2 MAPPER] No valid wages found to map to Line 1');
    }

    // Line 25a: Federal income tax withheld from Form(s) W-2
    const federalTaxWithheldValue = actualW2Data.federalTaxWithheld || actualW2Data.FederalIncomeTaxWithheld || 
                                   actualW2Data['FederalIncomeTaxWithheld'] || actualW2Data.box2 || 
                                   actualW2Data.Box2 || actualW2Data['Box 2'] || actualW2Data['federal_tax_withheld'];
    
    console.log('🔍 [W2 MAPPER] Found federal tax withheld value:', federalTaxWithheldValue, 'type:', typeof federalTaxWithheldValue);
    const federalTaxWithheld = this.parseAmount(federalTaxWithheldValue);
    console.log('🔍 [W2 MAPPER] Parsed federal tax withheld amount:', federalTaxWithheld);
    
    if (federalTaxWithheld > 0) {
      form1040Data.line25a = (form1040Data.line25a || 0) + federalTaxWithheld;
      console.log('✅ [W2 MAPPER] Successfully mapped federal tax withheld to Line 25a:', form1040Data.line25a);
    } else {
      console.log('⚠️ [W2 MAPPER] No valid federal tax withheld found to map to Line 25a');
    }

    // Calculate total income (Line 9) - simplified calculation
    form1040Data.line9 = this.calculateTotalIncome(form1040Data);

    // Calculate AGI (Line 11) - simplified (no adjustments for now)
    form1040Data.line11 = form1040Data.line9;

    // Apply standard deduction (Line 12) if not itemizing
    if (!form1040Data.line12 && form1040Data.filingStatus) {
      form1040Data.line12 = this.getStandardDeduction(form1040Data.filingStatus);
    }

    // Calculate taxable income (Line 15)
    form1040Data.line15 = Math.max(0, (form1040Data.line11 || 0) - (form1040Data.line12 || 0) - (form1040Data.line13 || 0));

    // Calculate tax liability (Line 16) - simplified
    form1040Data.line16 = this.calculateTaxLiability(form1040Data.line15 || 0, form1040Data.filingStatus);

    // Calculate total tax (Line 24) - simplified
    form1040Data.line24 = (form1040Data.line16 || 0) + (form1040Data.line17 || 0) + (form1040Data.line23 || 0);

    // Calculate total payments (Line 32)
    form1040Data.line32 = (form1040Data.line25a || 0) + (form1040Data.line25b || 0) + (form1040Data.line25c || 0) + (form1040Data.line25d || 0);

    // Calculate refund or amount owed
    const totalTax = form1040Data.line24 || 0;
    const totalPayments = form1040Data.line32 || 0;

    if (totalPayments > totalTax) {
      // Refund
      form1040Data.line33 = totalPayments - totalTax;
      form1040Data.line34 = form1040Data.line33; // Default to full refund
      form1040Data.line37 = 0;
    } else {
      // Amount owed
      form1040Data.line33 = 0;
      form1040Data.line34 = 0;
      form1040Data.line37 = totalTax - totalPayments;
    }

    console.log('✅ [W2 MAPPER] Mapping completed successfully');
    if (process.env.NODE_ENV === 'development') {
      console.log('🔍 [W2 MAPPER] Final form1040Data:', JSON.stringify(form1040Data, null, 2));
    }
    return form1040Data;
  }

  /**
   * Universal OCR extraction for employee information - works with all W-2 formats
   */
  private static extractEmployeeInfoFromOCR(ocrText: string): { name?: string; address?: string } {
    console.log('🔍 [W2 OCR] Universal employee info extraction starting...');
    
    // Comprehensive exclusion list for false positives
    const excludePatterns = [
      'EARNINGS SUMMARY', 'PAY PERIOD', 'TRIAL', 'EVALUATION', 'PURPOSES ONLY',
      'SUBSTITUTE', 'STATEMENT', 'COPY', 'FEDERAL', 'STATE', 'LOCAL', 'CITY',
      'WAGE AND TAX', 'FORM W-2', 'OMB NO', 'DEPARTMENT', 'TREASURY', 'IRS',
      'INTERNAL REVENUE', 'SERVICE', 'INSTRUCTIONS', 'EMPLOYEE', 'EMPLOYER',
      'SOCIAL SECURITY', 'MEDICARE', 'WITHHOLDING', 'DEDUCTION', 'CREDIT',
      'FILING', 'RETURN', 'INCOME TAX', 'GROSS PAY', 'NET PAY', 'YTD',
      'YEAR TO DATE', 'QUARTERLY', 'MONTHLY', 'WEEKLY', 'BIWEEKLY',
      'PAYROLL', 'BENEFITS', 'DEDUCTIONS', 'ALLOWANCES', 'EXEMPTIONS',
      'MARITAL STATUS', 'DEPENDENTS', 'WITHHOLDING ALLOWANCES',
      'BOX', 'LINE', 'SECTION', 'PART', 'SCHEDULE', 'ATTACHMENT',
      'SEE INSTRUCTIONS', 'COMPLETE', 'ENTER', 'AMOUNT', 'TOTAL',
      'SUBTOTAL', 'BALANCE', 'PREVIOUS', 'CURRENT', 'ADJUSTMENT'
    ];

    // Universal patterns for employee name extraction
    const namePatterns = [
      // Pattern 1: Standard W-2 format "e/f Employee's name, address, and ZIP code NAME ADDRESS"
      {
        regex: /e\/f\s+Employee's\s+name,\s+address,?\s+and\s+ZIP\s+code\s+([A-Z][A-Z\s]{2,30}?)\s+(\d+\s+[A-Z\s]+?\s+[A-Z]{2}\s+\d{5})/i,
        nameIndex: 1,
        addressIndex: 2,
        score: 10
      },
      
      // Pattern 2: Multi-line format
      {
        regex: /e\/f\s+Employee's\s+name,\s+address\s+and\s+ZIP\s+code\s*\n\s*([A-Z]+)\s*\n\s*([A-Z]+)\s*\n\s*(\d+\s+[A-Z\s]+?\s+[A-Z]{2}\s+\d{5})/i,
        nameIndex: [1, 2], // Combine first and last name
        addressIndex: 3,
        score: 9
      },
      
      // Pattern 3: Simplified employee section
      {
        regex: /Employee's\s+name[^:]*:\s*([A-Z][A-Z\s]{2,30}?)(?:\s+\d+|\s+[A-Z]{2}\s+\d{5})/i,
        nameIndex: 1,
        addressIndex: null,
        score: 8
      },
      
      // Pattern 4: Name followed by address pattern
      {
        regex: /\b([A-Z]{2,}\s+[A-Z]{2,})\s+(\d{3,5}\s+[A-Z\s]+?\s+[A-Z]{2}\s+\d{5})/i,
        nameIndex: 1,
        addressIndex: 2,
        score: 7,
        contextCheck: true // Requires context validation
      },
      
      // Pattern 5: Two capitalized words followed by address
      {
        regex: /\b([A-Z]{2,}\s+[A-Z]{2,})\s*\n\s*(\d{3,5}\s+[A-Z\s]+?\s+[A-Z]{2}\s+\d{5})/i,
        nameIndex: 1,
        addressIndex: 2,
        score: 6,
        contextCheck: true
      },
      
      // Pattern 6: Name in quotes (some OCR formats)
      {
        regex: /"([A-Z][A-Z\s]{2,30}?)"\s*(?:.*?)(\d+\s+[A-Z\s]+?\s+[A-Z]{2}\s+\d{5})/i,
        nameIndex: 1,
        addressIndex: 2,
        score: 8
      }
    ];

    const candidates = [];

    // Try each pattern
    for (const pattern of namePatterns) {
      const match = ocrText.match(pattern.regex);
      if (match) {
        let name, address;
        
        if (Array.isArray(pattern.nameIndex)) {
          // Combine multiple name parts
          name = pattern.nameIndex.map(i => match[i]).join(' ').trim();
        } else {
          name = match[pattern.nameIndex]?.trim();
        }
        
        if (pattern.addressIndex) {
          address = match[pattern.addressIndex]?.trim();
        }

        if (name) {
          // Validate name
          const isValidName = this.validateEmployeeName(name, excludePatterns, ocrText, pattern.contextCheck);
          
          if (isValidName) {
            candidates.push({
              name: this.formatName(name),
              address: address || '',
              score: pattern.score,
              pattern: pattern.regex.source
            });
            
            console.log(`✅ [W2 OCR] Found candidate: ${name} (score: ${pattern.score})`);
          }
        }
      }
    }

    // Return the best candidate
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      
      console.log('✅ [W2 OCR] Selected best candidate:', best.name);
      return { name: best.name, address: best.address };
    }

    console.log('⚠️ [W2 OCR] No valid employee name found');
    return {};
  }

  /**
   * Validates if extracted text is a real employee name
   */
  private static validateEmployeeName(name: string, excludePatterns: string[], ocrText: string, contextCheck: boolean = false): boolean {
    // Basic validation
    if (!name || name.length < 3 || name.length > 50) return false;
    
    // Must have at least 2 words
    const words = name.trim().split(/\s+/);
    if (words.length < 2) return false;
    
    // Each word should be reasonable length
    if (words.some(word => word.length < 2 || word.length > 20)) return false;
    
    // Check against exclusion patterns
    const upperName = name.toUpperCase();
    for (const pattern of excludePatterns) {
      if (upperName.includes(pattern)) {
        console.log(`❌ [W2 OCR] Excluded "${name}" - matches pattern: ${pattern}`);
        return false;
      }
    }
    
    // Context check for ambiguous patterns
    if (contextCheck) {
      const nameIndex = ocrText.indexOf(name);
      if (nameIndex !== -1) {
        const before = ocrText.substring(Math.max(0, nameIndex - 100), nameIndex).toUpperCase();
        const after = ocrText.substring(nameIndex + name.length, nameIndex + name.length + 100).toUpperCase();
        
        // Should not appear in header sections
        if (before.includes('EARNINGS SUMMARY') || before.includes('TRIAL') || 
            after.includes('COPY') || after.includes('STATEMENT')) {
          console.log(`❌ [W2 OCR] Excluded "${name}" - appears in header context`);
          return false;
        }
        
        // Should appear near employee-related text
        if (!before.includes('EMPLOYEE') && !after.includes('EMPLOYEE') &&
            !before.includes('NAME') && !after.includes('ADDRESS')) {
          console.log(`❌ [W2 OCR] Excluded "${name}" - no employee context found`);
          return false;
        }
      }
    }
    
    // Additional validation: should not be all the same letter
    if (new Set(name.replace(/\s/g, '')).size < 3) return false;
    
    // Should not contain numbers (except maybe Jr, Sr, III)
    if (/\d/.test(name) && !/\b(JR|SR|III|IV|V)\b/i.test(name)) return false;
    
    return true;
  }

  /**
   * Universal OCR extraction for employer information
   */
  private static extractEmployerInfoFromOCR(ocrText: string): { name?: string; address?: string; ein?: string } {
    console.log('🔍 [W2 OCR] Universal employer info extraction starting...');
    
    const employerPatterns = [
      // Standard employer section
      /c\s+Employer's\s+name,\s+address,\s+and\s+ZIP\s+code\s*\n([\s\S]*?)(?=\n\s*[a-z]\s+[A-Z]|$)/i,
      
      // Alternative employer section
      /Employer's\s+name[^:]*:\s*([A-Z][A-Z\s&.,]+?)\s*\n\s*([A-Z0-9\s,.-]+?\s+[A-Z]{2}\s+\d{5})/i,
      
      // Employer info in single line
      /Employer[^:]*:\s*([A-Z][A-Z\s&.,]+?)\s+(\d+\s+[A-Z\s]+?\s+[A-Z]{2}\s+\d{5})/i
    ];

    let name, address;

    for (const pattern of employerPatterns) {
      const match = ocrText.match(pattern);
      if (match) {
        if (pattern === employerPatterns[0]) {
          // Multi-line format
          const employerBlock = match[1].trim();
          const lines = employerBlock.split('\n').map(line => line.trim()).filter(line => line.length > 0);
          
          if (lines.length >= 2) {
            name = lines[0];
            address = lines.slice(1).join(' ');
          }
        } else {
          // Single line formats
          name = match[1]?.trim();
          address = match[2]?.trim();
        }
        
        if (name && this.validateEmployerName(name)) {
          console.log('✅ [W2 OCR] Found employer:', name);
          break;
        }
      }
    }

    // Extract EIN
    const einPatterns = [
      /b\s+Employer's\s+FED\s+ID\s+number\s+([0-9]{2}-[0-9]{7})/i,
      /Employer\s+ID[^:]*:\s*([0-9]{2}-[0-9]{7})/i,
      /EIN[^:]*:\s*([0-9]{2}-[0-9]{7})/i,
      /Federal\s+ID[^:]*:\s*([0-9]{2}-[0-9]{7})/i
    ];

    let ein;
    for (const pattern of einPatterns) {
      const match = ocrText.match(pattern);
      if (match) {
        ein = match[1];
        console.log('✅ [W2 OCR] Found EIN:', ein);
        break;
      }
    }

    return { name, address, ein };
  }

  /**
   * Validates employer name
   */
  private static validateEmployerName(name: string): boolean {
    if (!name || name.length < 3 || name.length > 100) return false;
    
    const excludeWords = ['EMPLOYEE', 'WAGES', 'TIPS', 'COMPENSATION', 'WITHHOLDING', 'FEDERAL', 'STATE'];
    const upperName = name.toUpperCase();
    
    return !excludeWords.some(word => upperName.includes(word));
  }

  /**
   * Format name from "MICHAEL JACKSON" to "Michael Jackson"
   */
  private static formatName(name: string): string {
    return name.toLowerCase()
      .split(' ')
      .map(word => word.charAt(0).toUpperCase() + word.slice(1))
      .join(' ');
  }

  /**
   * Creates a mapping summary showing what W2 fields mapped to which 1040 lines
   */
  static createMappingSummary(w2Data: any): Array<{
    w2Field: string;
    w2Value: any;
    form1040Line: string;
    form1040Value: any;
    description: string;
  }> {
    const mappings = [];

    if (w2Data.employeeName) {
      mappings.push({
        w2Field: 'Employee Name',
        w2Value: w2Data.employeeName,
        form1040Line: 'Header',
        form1040Value: w2Data.employeeName,
        description: 'Taxpayer name from W2'
      });
    }

    if (w2Data.employeeSSN) {
      mappings.push({
        w2Field: 'Employee SSN',
        w2Value: w2Data.employeeSSN,
        form1040Line: 'Header',
        form1040Value: this.formatSSN(w2Data.employeeSSN),
        description: 'Taxpayer SSN from W2'
      });
    }

    if (w2Data.employeeAddress) {
      mappings.push({
        w2Field: 'Employee Address',
        w2Value: w2Data.employeeAddress,
        form1040Line: 'Header',
        form1040Value: w2Data.employeeAddress,
        description: 'Taxpayer address from W2'
      });
    }

    if (w2Data.wages) {
      mappings.push({
        w2Field: 'Box 1 - Wages',
        w2Value: w2Data.wages,
        form1040Line: 'Line 1',
        form1040Value: this.parseAmount(w2Data.wages),
        description: 'Wages, tips, other compensation'
      });
    }

    if (w2Data.federalTaxWithheld) {
      mappings.push({
        w2Field: 'Box 2 - Federal Tax Withheld',
        w2Value: w2Data.federalTaxWithheld,
        form1040Line: 'Line 25a',
        form1040Value: this.parseAmount(w2Data.federalTaxWithheld),
        description: 'Federal income tax withheld'
      });
    }

    if (w2Data.socialSecurityWages) {
      mappings.push({
        w2Field: 'Box 3 - Social Security Wages',
        w2Value: w2Data.socialSecurityWages,
        form1040Line: 'Informational',
        form1040Value: this.parseAmount(w2Data.socialSecurityWages),
        description: 'Social security wages (informational)'
      });
    }

    if (w2Data.medicareWages) {
      mappings.push({
        w2Field: 'Box 5 - Medicare Wages',
        w2Value: w2Data.medicareWages,
        form1040Line: 'Informational',
        form1040Value: this.parseAmount(w2Data.medicareWages),
        description: 'Medicare wages and tips (informational)'
      });
    }

    return mappings;
  }

  private static parseAmount(value: any): number {
    console.log('🔍 [PARSE AMOUNT] Input value:', value, 'type:', typeof value);
    
    if (value === null || value === undefined) {
      console.log('🔍 [PARSE AMOUNT] Value is null/undefined, returning 0');
      return 0;
    }
    
    if (typeof value === 'number') {
      console.log('🔍 [PARSE AMOUNT] Value is already a number:', value);
      return isNaN(value) ? 0 : value;
    }
    
    if (typeof value === 'string') {
      // Remove currency symbols, commas, and whitespace
      const cleaned = value.replace(/[$,\s]/g, '');
      console.log('🔍 [PARSE AMOUNT] Cleaned string:', cleaned);
      const parsed = parseFloat(cleaned);
      const result = isNaN(parsed) ? 0 : parsed;
      console.log('🔍 [PARSE AMOUNT] Parsed result:', result);
      return result;
    }
    
    // Handle objects that might have a value property
    if (typeof value === 'object' && value.value !== undefined) {
      console.log('🔍 [PARSE AMOUNT] Object with value property:', value.value);
      return this.parseAmount(value.value);
    }
    
    // Handle objects that might have a content property (Azure DI format)
    if (typeof value === 'object' && value.content !== undefined) {
      console.log('🔍 [PARSE AMOUNT] Object with content property:', value.content);
      return this.parseAmount(value.content);
    }
    
    console.log('🔍 [PARSE AMOUNT] Unable to parse value, returning 0');
    return 0;
  }

  /**
   * Universal wages extraction from OCR text
   */
  private static extractWagesFromOCR(ocrText: string): number {
    console.log('🔍 [W2 MAPPER OCR] Universal wages extraction starting...');
    
    // Comprehensive wage patterns for all formats
    const wagePatterns = [
      // Standard Box 1 patterns
      /\b1\s+Wages[,\s]*tips[,\s]*other\s+(?:comp|compensation)\.?\s+([\d,]+\.?\d*)/i,
      /\b1\.?\s*Wages[,\s]*tips[,\s]*other\s+(?:comp|compensation)\.?[:\s]+\$?([\d,]+\.?\d*)/i,
      /Box\s*1[^0-9]*?([\d,]+\.?\d*)/i,
      
      // Alternative formats
      /Wages[,\s]*tips[,\s]*other\s+comp\.?\s+\$?([\d,]+\.?\d*)/i,
      /Wages\s+and\s+tips\s+\$?([\d,]+\.?\d*)/i,
      /Total\s+wages\s+\$?([\d,]+\.?\d*)/i,
      
      // Multi-line patterns
      /\b1\s+Wages[,\s]*tips[,\s]*other\s+(?:comp|compensation)\.?[\s\n]+\$?([\d,]+\.?\d*)/i,
      
      // Numeric patterns with context
      /(?:^|\n)\s*1\s+\$?([\d,]+\.?\d*)\s*(?:\n|$)/m,
      
      // Fallback patterns
      /(?:wages|compensation)[^0-9]*?([\d,]{4,}\.?\d*)/i
    ];

    const candidates = [];

    for (const pattern of wagePatterns) {
      const matches = [...ocrText.matchAll(new RegExp(pattern.source, pattern.flags + 'g'))];
      
      for (const match of matches) {
        if (match[1]) {
          const wageString = match[1];
          const cleanedAmount = wageString.replace(/[,$\s]/g, '');
          const parsedAmount = parseFloat(cleanedAmount);
          
          if (!isNaN(parsedAmount) && parsedAmount > 0 && parsedAmount < 100000000) {
            // Score based on pattern specificity and context
            let score = 1;
            if (pattern.source.includes('Box\\s*1')) score += 3;
            if (pattern.source.includes('Wages.*tips.*comp')) score += 2;
            if (parsedAmount > 1000 && parsedAmount < 10000000) score += 1;
            
            candidates.push({
              amount: parsedAmount,
              score: score,
              pattern: pattern.source,
              match: match[0]
            });
            
            console.log(`🔍 [W2 OCR] Found wage candidate: ${parsedAmount} (score: ${score})`);
          }
        }
      }
    }

    // Return the best candidate
    if (candidates.length > 0) {
      candidates.sort((a, b) => b.score - a.score);
      const best = candidates[0];
      
      console.log('✅ [W2 MAPPER OCR] Selected best wage candidate:', best.amount);
      return best.amount;
    }

    console.log('⚠️ [W2 MAPPER OCR] No wages found in OCR text');
    return 0;
  }

  private static formatSSN(ssn: string): string {
    if (!ssn) return '';
    // Remove all non-digits
    const cleaned = ssn.replace(/\D/g, '');
    // Format as XXX-XX-XXXX
    if (cleaned.length === 9) {
      return `${cleaned.slice(0, 3)}-${cleaned.slice(3, 5)}-${cleaned.slice(5)}`;
    }
    return cleaned;
  }

  private static parseAddress(address: string): {
    street: string;
    city: string;
    state: string;
    zipCode: string;
  } {
    console.log('🔍 [ADDRESS PARSER] Parsing address:', address);
    
    // Enhanced address parsing to handle various formats
    // Try comma-separated format first
    const commaParts = address.split(',').map(part => part.trim());
    
    if (commaParts.length >= 3) {
      const street = commaParts.slice(0, -2).join(', ');
      const city = commaParts[commaParts.length - 2];
      const stateZip = commaParts[commaParts.length - 1];
      const stateZipMatch = stateZip.match(/^([A-Z]{2})\s*(\d{5}(-\d{4})?)$/);
      
      if (stateZipMatch) {
        const result = {
          street,
          city,
          state: stateZipMatch[1],
          zipCode: stateZipMatch[2]
        };
        console.log('✅ [ADDRESS PARSER] Parsed comma-separated address:', result);
        return result;
      }
    }
    
    // Try space-separated format: "Street Address City STATE ZIP"
    const spaceMatch = address.match(/^(.+?)\s+([A-Za-z\s]+?)\s+([A-Z]{2})\s+(\d{5}(-\d{4})?)$/);
    if (spaceMatch) {
      const result = {
        street: spaceMatch[1].trim(),
        city: spaceMatch[2].trim(),
        state: spaceMatch[3],
        zipCode: spaceMatch[4]
      };
      console.log('✅ [ADDRESS PARSER] Parsed space-separated address:', result);
      return result;
    }
    
    // Try alternative pattern where city might have multiple words
    const stateZipPattern = /\s+([A-Z]{2})\s+(\d{5}(-\d{4})?)$/;
    const stateZipMatch = address.match(stateZipPattern);
    
    if (stateZipMatch) {
      const beforeStateZip = address.substring(0, address.length - stateZipMatch[0].length);
      const words = beforeStateZip.trim().split(/\s+/);
      
      let streetEndIndex = words.length - 1;
      
      for (let i = 0; i < words.length; i++) {
        if (/^(apt|apartment|unit|suite|ste)\.?$/i.test(words[i])) {
          streetEndIndex = Math.min(i + 2, words.length - 1);
          break;
        }
      }
      
      if (words.length >= 2) {
        streetEndIndex = words.length - 2;
      }
      
      const street = words.slice(0, streetEndIndex + 1).join(' ');
      const city = words.slice(streetEndIndex + 1).join(' ');
      
      const result = {
        street,
        city,
        state: stateZipMatch[1],
        zipCode: stateZipMatch[2]
      };
      console.log('✅ [ADDRESS PARSER] Parsed pattern-matched address:', result);
      return result;
    }
    
    // Fallback: return the whole address as street
    const result = {
      street: address,
      city: '',
      state: '',
      zipCode: ''
    };
    console.log('⚠️ [ADDRESS PARSER] Could not parse address, using as street only:', result);
    return result;
  }

  private static calculateTotalIncome(form1040Data: Partial<Form1040Data>): number {
    return (
      (form1040Data.line1 || 0) +
      (form1040Data.line2b || 0) +
      (form1040Data.line3b || 0) +
      (form1040Data.line4b || 0) +
      (form1040Data.line5b || 0) +
      (form1040Data.line6b || 0) +
      (form1040Data.line7 || 0) +
      (form1040Data.line8 || 0)
    );
  }

  private static getStandardDeduction(filingStatus: any): number {
    const STANDARD_DEDUCTION_2023: Record<string, number> = {
      'SINGLE': 13850,
      'MARRIED_FILING_JOINTLY': 27700,
      'MARRIED_FILING_SEPARATELY': 13850,
      'HEAD_OF_HOUSEHOLD': 20800,
      'QUALIFYING_SURVIVING_SPOUSE': 27700
    };
    
    return STANDARD_DEDUCTION_2023[filingStatus] || STANDARD_DEDUCTION_2023['SINGLE'];
  }

  private static calculateTaxLiability(taxableIncome: number, filingStatus: any): number {
    // Simplified tax calculation using 2023 tax brackets
    const brackets: Array<{ min: number; max: number; rate: number }> = 
      filingStatus === 'MARRIED_FILING_JOINTLY' ? [
        { min: 0, max: 22000, rate: 0.10 },
        { min: 22000, max: 89450, rate: 0.12 },
        { min: 89450, max: 190750, rate: 0.22 },
        { min: 190750, max: 364200, rate: 0.24 },
        { min: 364200, max: 462500, rate: 0.32 },
        { min: 462500, max: 693750, rate: 0.35 },
        { min: 693750, max: Infinity, rate: 0.37 }
      ] : [
        { min: 0, max: 11000, rate: 0.10 },
        { min: 11000, max: 44725, rate: 0.12 },
        { min: 44725, max: 95375, rate: 0.22 },
        { min: 95375, max: 182050, rate: 0.24 },
        { min: 182050, max: 231250, rate: 0.32 },
        { min: 231250, max: 578125, rate: 0.35 },
        { min: 578125, max: Infinity, rate: 0.37 }
      ];

    let tax = 0;
    let remainingIncome = taxableIncome;

    for (const bracket of brackets) {
      if (remainingIncome <= 0) break;
      
      const taxableAtThisBracket = Math.min(remainingIncome, bracket.max - bracket.min);
      tax += taxableAtThisBracket * bracket.rate;
      remainingIncome -= taxableAtThisBracket;
    }

    return Math.round(tax * 100) / 100; // Round to 2 decimal places
  }

  /**
   * Validates that W2 data can be properly mapped to 1040
   */
  static validateW2DataForMapping(w2Data: any): {
    isValid: boolean;
    errors: string[];
    warnings: string[];
  } {
    const errors: string[] = [];
    const warnings: string[] = [];

    // Required fields
    if (!w2Data.wages && !w2Data.line1) {
      errors.push('W2 wages (Box 1) is required but not found');
    }

    if (!w2Data.employeeSSN && !w2Data.ssn) {
      errors.push('Employee SSN is required but not found');
    }

    if (!w2Data.employeeName && !w2Data.firstName && !w2Data.lastName) {
      errors.push('Employee name is required but not found');
    }

    // Warnings for missing optional but important fields
    if (!w2Data.federalTaxWithheld) {
      warnings.push('Federal tax withheld (Box 2) not found - no withholdings will be applied');
    }

    if (!w2Data.employerName) {
      warnings.push('Employer name not found - may be needed for verification');
    }

    if (!w2Data.employerEIN) {
      warnings.push('Employer EIN not found - may be needed for verification');
    }

    if (!w2Data.employeeAddress) {
      warnings.push('Employee address not found - address fields may not be auto-populated');
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings
    };
  }
}
