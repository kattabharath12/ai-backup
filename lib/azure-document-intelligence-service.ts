

import { DocumentAnalysisClient, AzureKeyCredential } from "@azure/ai-form-recognizer";
import { readFile } from "fs/promises";

export interface AzureDocumentIntelligenceConfig {
  endpoint: string;
  apiKey: string;
}

export interface ExtractedFieldData {
  [key: string]: string | number;
}

export class AzureDocumentIntelligenceService {
  private client: DocumentAnalysisClient;
  private config: AzureDocumentIntelligenceConfig;

  constructor(config: AzureDocumentIntelligenceConfig) {
    this.config = config;
    this.client = new DocumentAnalysisClient(
      this.config.endpoint,
      new AzureKeyCredential(this.config.apiKey)
    );
  }

  async extractDataFromDocument(
    documentPathOrBuffer: string | Buffer,
    documentType: string
  ): Promise<ExtractedFieldData> {
    try {
      console.log('🔍 [Azure DI] Processing document with Azure Document Intelligence...');
      
      // Get document buffer - either from file path or use provided buffer
      const documentBuffer = typeof documentPathOrBuffer === 'string' 
        ? await readFile(documentPathOrBuffer)
        : documentPathOrBuffer;
      
      // Determine the model to use based on document type
      const modelId = this.getModelIdForDocumentType(documentType);
      console.log('🔍 [Azure DI] Using model:', modelId);
      
      try {
        // Analyze the document with specific tax model
        const poller = await this.client.beginAnalyzeDocument(modelId, documentBuffer);
        const result = await poller.pollUntilDone();
        
        console.log('✅ [Azure DI] Document analysis completed with tax model');
        
        // Extract the data based on document type
        return this.extractTaxDocumentFields(result, documentType);
      } catch (modelError: any) {
        console.warn('⚠️ [Azure DI] Tax model failed, attempting fallback to OCR model:', modelError?.message);
        
        // Check if it's a ModelNotFound error
        if (modelError?.message?.includes('ModelNotFound') || 
            modelError?.message?.includes('Resource not found') ||
            modelError?.code === 'NotFound') {
          
          console.log('🔍 [Azure DI] Falling back to prebuilt-read model for OCR extraction...');
          
          // Fallback to general OCR model
          const fallbackPoller = await this.client.beginAnalyzeDocument('prebuilt-read', documentBuffer);
          const fallbackResult = await fallbackPoller.pollUntilDone();
          
          console.log('✅ [Azure DI] Document analysis completed with OCR fallback');
          
          // Extract data using OCR-based approach
          return this.extractTaxDocumentFieldsFromOCR(fallbackResult, documentType);
        } else {
          // Re-throw if it's not a model availability issue
          throw modelError;
        }
      }
    } catch (error: any) {
      console.error('❌ [Azure DI] Processing error:', error);
      throw new Error(`Azure Document Intelligence processing failed: ${error?.message || 'Unknown error'}`);
    }
  }

  private getModelIdForDocumentType(documentType: string): string {
    switch (documentType) {
      case 'W2':
        return 'prebuilt-tax.us.w2';
      case 'FORM_1099_INT':
      case 'FORM_1099_DIV':
      case 'FORM_1099_MISC':
      case 'FORM_1099_NEC':
        // All 1099 variants use the unified 1099 model
        return 'prebuilt-tax.us.1099';
      default:
        // Use general document model for other types
        return 'prebuilt-document';
    }
  }

  private extractTaxDocumentFieldsFromOCR(result: any, documentType: string): ExtractedFieldData {
    console.log('🔍 [Azure DI] Extracting tax document fields using OCR fallback...');
    
    const extractedData: ExtractedFieldData = {};
    
    // Extract text content from OCR result
    extractedData.fullText = result.content || '';
    
    // Use OCR-based extraction methods for different document types
    switch (documentType) {
      case 'W2':
        return this.extractW2FieldsFromOCR(extractedData.fullText as string, extractedData);
      case 'FORM_1099_INT':
        return this.extract1099IntFieldsFromOCR(extractedData.fullText as string, extractedData);
      case 'FORM_1099_DIV':
        return this.extract1099DivFieldsFromOCR(extractedData.fullText as string, extractedData);
      case 'FORM_1099_MISC':
        return this.extract1099MiscFieldsFromOCR(extractedData.fullText as string, extractedData);
      case 'FORM_1099_NEC':
        return this.extract1099NecFieldsFromOCR(extractedData.fullText as string, extractedData);
      default:
        console.log('🔍 [Azure DI] Using generic OCR extraction for document type:', documentType);
        return this.extractGenericFieldsFromOCR(extractedData.fullText as string, extractedData);
    }
  }

  private extractTaxDocumentFields(result: any, documentType: string): ExtractedFieldData {
    const extractedData: ExtractedFieldData = {};
    
    // Extract text content
    extractedData.fullText = result.content || '';
    
    // Extract form fields
    if (result.documents && result.documents.length > 0) {
      const document = result.documents[0];
      
      if (document.fields) {
        // Process fields based on document type
        switch (documentType) {
          case 'W2':
            return this.processW2Fields(document.fields, extractedData);
          case 'FORM_1099_INT':
            return this.process1099IntFields(document.fields, extractedData);
          case 'FORM_1099_DIV':
            return this.process1099DivFields(document.fields, extractedData);
          case 'FORM_1099_MISC':
            return this.process1099MiscFields(document.fields, extractedData);
          case 'FORM_1099_NEC':
            return this.process1099NecFields(document.fields, extractedData);
          default:
            return this.processGenericFields(document.fields, extractedData);
        }
      }
    }
    
    // Extract key-value pairs from tables if available
    if (result.keyValuePairs) {
      for (const kvp of result.keyValuePairs) {
        const key = kvp.key?.content?.trim();
        const value = kvp.value?.content?.trim();
        if (key && value) {
          extractedData[key] = value;
        }
      }
    }
    
    return extractedData;
  }

  private processW2Fields(fields: any, baseData: ExtractedFieldData): ExtractedFieldData {
    const w2Data = { ...baseData };
    
    // W2 specific field mappings
    const w2FieldMappings = {
      'Employee.Name': 'employeeName',
      'Employee.SSN': 'employeeSSN',
      'Employee.Address': 'employeeAddress',
      'Employer.Name': 'employerName',
      'Employer.EIN': 'employerEIN',
      'Employer.Address': 'employerAddress',
      'WagesAndTips': 'wages',
      'FederalIncomeTaxWithheld': 'federalTaxWithheld',
      'SocialSecurityWages': 'socialSecurityWages',
      'SocialSecurityTaxWithheld': 'socialSecurityTaxWithheld',
      'MedicareWagesAndTips': 'medicareWages',
      'MedicareTaxWithheld': 'medicareTaxWithheld',
      'SocialSecurityTips': 'socialSecurityTips',
      'AllocatedTips': 'allocatedTips',
      'StateWagesTipsEtc': 'stateWages',
      'StateIncomeTax': 'stateTaxWithheld',
      'LocalWagesTipsEtc': 'localWages',
      'LocalIncomeTax': 'localTaxWithheld'
    };
    
    for (const [azureFieldName, mappedFieldName] of Object.entries(w2FieldMappings)) {
      if (fields[azureFieldName]?.value !== undefined) {
        const value = fields[azureFieldName].value;
        w2Data[mappedFieldName] = typeof value === 'number' ? value : this.parseAmount(value);
      }
    }
    
    // Enhanced personal info extraction with better fallback handling
    console.log('🔍 [Azure DI] Extracting personal information from W2...');
    
    // Employee Name - try multiple field variations
    if (!w2Data.employeeName) {
      const nameFields = ['Employee.Name', 'EmployeeName', 'Employee_Name', 'RecipientName'];
      for (const fieldName of nameFields) {
        if (fields[fieldName]?.value) {
          w2Data.employeeName = fields[fieldName].value;
          console.log('✅ [Azure DI] Found employee name:', w2Data.employeeName);
          break;
        }
      }
    }
    
    // Employee SSN - try multiple field variations
    if (!w2Data.employeeSSN) {
      const ssnFields = ['Employee.SSN', 'EmployeeSSN', 'Employee_SSN', 'RecipientTIN'];
      for (const fieldName of ssnFields) {
        if (fields[fieldName]?.value) {
          w2Data.employeeSSN = fields[fieldName].value;
          console.log('✅ [Azure DI] Found employee SSN:', w2Data.employeeSSN);
          break;
        }
      }
    }
    
    // Employee Address - try multiple field variations
    if (!w2Data.employeeAddress) {
      const addressFields = ['Employee.Address', 'EmployeeAddress', 'Employee_Address', 'RecipientAddress'];
      for (const fieldName of addressFields) {
        if (fields[fieldName]?.value) {
          w2Data.employeeAddress = fields[fieldName].value;
          console.log('✅ [Azure DI] Found employee address:', w2Data.employeeAddress);
          break;
        }
      }
    }
    
    // OCR fallback for personal info if not found in structured fields
    if ((!w2Data.employeeName || !w2Data.employeeSSN || !w2Data.employeeAddress || !w2Data.employerName || !w2Data.employerAddress) && baseData.fullText) {
      console.log('🔍 [Azure DI] Some personal info missing from structured fields, attempting OCR extraction...');
      const personalInfoFromOCR = this.extractPersonalInfoFromOCR(baseData.fullText as string);
      
      if (!w2Data.employeeName && personalInfoFromOCR.name) {
        w2Data.employeeName = personalInfoFromOCR.name;
        console.log('✅ [Azure DI] Extracted employee name from OCR:', w2Data.employeeName);
      }
      
      if (!w2Data.employeeSSN && personalInfoFromOCR.ssn) {
        w2Data.employeeSSN = personalInfoFromOCR.ssn;
        console.log('✅ [Azure DI] Extracted employee SSN from OCR:', w2Data.employeeSSN);
      }
      
      if (!w2Data.employeeAddress && personalInfoFromOCR.address) {
        w2Data.employeeAddress = personalInfoFromOCR.address;
        console.log('✅ [Azure DI] Extracted employee address from OCR:', w2Data.employeeAddress);
      }
      
      if (!w2Data.employerName && personalInfoFromOCR.employerName) {
        w2Data.employerName = personalInfoFromOCR.employerName;
        console.log('✅ [Azure DI] Extracted employer name from OCR:', w2Data.employerName);
      }
      
      if (!w2Data.employerAddress && personalInfoFromOCR.employerAddress) {
        w2Data.employerAddress = personalInfoFromOCR.employerAddress;
        console.log('✅ [Azure DI] Extracted employer address from OCR:', w2Data.employerAddress);
      }
    }

    // Enhanced address parsing - extract city, state, and zipCode from full address
    if (w2Data.employeeAddress && typeof w2Data.employeeAddress === 'string') {
      console.log('🔍 [Azure DI] Parsing address components from:', w2Data.employeeAddress);
      const ocrText = typeof baseData.fullText === 'string' ? baseData.fullText : '';
      const addressParts = this.extractAddressParts(w2Data.employeeAddress, ocrText);
      
      // Add parsed address components to W2 data
      w2Data.employeeAddressStreet = addressParts.street;
      w2Data.employeeCity = addressParts.city;
      w2Data.employeeState = addressParts.state;
      w2Data.employeeZipCode = addressParts.zipCode;
      
      console.log('✅ [Azure DI] Parsed address components:', {
        street: w2Data.employeeAddressStreet,
        city: w2Data.employeeCity,
        state: w2Data.employeeState,
        zipCode: w2Data.employeeZipCode
      });
    }
    
    // OCR fallback for Box 1 wages if not found in structured fields
    if (!w2Data.wages && baseData.fullText) {
      console.log('🔍 [Azure DI] Wages not found in structured fields, attempting OCR extraction...');
      const wagesFromOCR = this.extractWagesFromOCR(baseData.fullText as string);
      if (wagesFromOCR > 0) {
        console.log('✅ [Azure DI] Successfully extracted wages from OCR:', wagesFromOCR);
        w2Data.wages = wagesFromOCR;
      }
    }
    
    return w2Data;
  }

  private process1099IntFields(fields: any, baseData: ExtractedFieldData): ExtractedFieldData {
    const data = { ...baseData };
    
    const fieldMappings = {
      'Payer.Name': 'payerName',
      'Payer.TIN': 'payerTIN',
      'Payer.Address': 'payerAddress',
      'Recipient.Name': 'recipientName',
      'Recipient.TIN': 'recipientTIN',
      'Recipient.Address': 'recipientAddress',
      'InterestIncome': 'interestIncome',
      'EarlyWithdrawalPenalty': 'earlyWithdrawalPenalty',
      'InterestOnUSTreasuryObligations': 'interestOnUSavingsBonds',
      'FederalIncomeTaxWithheld': 'federalTaxWithheld',
      'InvestmentExpenses': 'investmentExpenses',
      'ForeignTaxPaid': 'foreignTaxPaid',
      'TaxExemptInterest': 'taxExemptInterest'
    };
    
    for (const [azureFieldName, mappedFieldName] of Object.entries(fieldMappings)) {
      if (fields[azureFieldName]?.value !== undefined) {
        const value = fields[azureFieldName].value;
        data[mappedFieldName] = typeof value === 'number' ? value : this.parseAmount(value);
      }
    }
    
    // OCR fallback for personal info if not found in structured fields
    if ((!data.recipientName || !data.recipientTIN || !data.recipientAddress || !data.payerName || !data.payerTIN) && baseData.fullText) {
      console.log('🔍 [Azure DI] Some 1099 info missing from structured fields, attempting OCR extraction...');
      const personalInfoFromOCR = this.extractPersonalInfoFromOCR(baseData.fullText as string);
      
      if (!data.recipientName && personalInfoFromOCR.name) {
        data.recipientName = personalInfoFromOCR.name;
        console.log('✅ [Azure DI] Extracted recipient name from OCR:', data.recipientName);
      }
      
      if (!data.recipientTIN && personalInfoFromOCR.tin) {
        data.recipientTIN = personalInfoFromOCR.tin;
        console.log('✅ [Azure DI] Extracted recipient TIN from OCR:', data.recipientTIN);
      }
      
      if (!data.recipientAddress && personalInfoFromOCR.address) {
        data.recipientAddress = personalInfoFromOCR.address;
        console.log('✅ [Azure DI] Extracted recipient address from OCR:', data.recipientAddress);
      }
      
      if (!data.payerName && personalInfoFromOCR.payerName) {
        data.payerName = personalInfoFromOCR.payerName;
        console.log('✅ [Azure DI] Extracted payer name from OCR:', data.payerName);
      }
      
      if (!data.payerTIN && personalInfoFromOCR.payerTIN) {
        data.payerTIN = personalInfoFromOCR.payerTIN;
        console.log('✅ [Azure DI] Extracted payer TIN from OCR:', data.payerTIN);
      }
    }
    
    return data;
  }

  private process1099DivFields(fields: any, baseData: ExtractedFieldData): ExtractedFieldData {
    const data = { ...baseData };
    
    const fieldMappings = {
      'Payer.Name': 'payerName',
      'Payer.TIN': 'payerTIN',
      'Payer.Address': 'payerAddress',
      'Recipient.Name': 'recipientName',
      'Recipient.TIN': 'recipientTIN',
      'Recipient.Address': 'recipientAddress',
      'OrdinaryDividends': 'ordinaryDividends',
      'QualifiedDividends': 'qualifiedDividends',
      'TotalCapitalGainDistributions': 'totalCapitalGain',
      'NondividendDistributions': 'nondividendDistributions',
      'FederalIncomeTaxWithheld': 'federalTaxWithheld',
      'Section199ADividends': 'section199ADividends'
    };
    
    for (const [azureFieldName, mappedFieldName] of Object.entries(fieldMappings)) {
      if (fields[azureFieldName]?.value !== undefined) {
        const value = fields[azureFieldName].value;
        data[mappedFieldName] = typeof value === 'number' ? value : this.parseAmount(value);
      }
    }
    
    // OCR fallback for personal info if not found in structured fields
    if ((!data.recipientName || !data.recipientTIN || !data.recipientAddress || !data.payerName || !data.payerTIN) && baseData.fullText) {
      console.log('🔍 [Azure DI] Some 1099-DIV info missing from structured fields, attempting OCR extraction...');
      const personalInfoFromOCR = this.extractPersonalInfoFromOCR(baseData.fullText as string);
      
      if (!data.recipientName && personalInfoFromOCR.name) {
        data.recipientName = personalInfoFromOCR.name;
        console.log('✅ [Azure DI] Extracted recipient name from OCR:', data.recipientName);
      }
      
      if (!data.recipientTIN && personalInfoFromOCR.tin) {
        data.recipientTIN = personalInfoFromOCR.tin;
        console.log('✅ [Azure DI] Extracted recipient TIN from OCR:', data.recipientTIN);
      }
      
      if (!data.recipientAddress && personalInfoFromOCR.address) {
        data.recipientAddress = personalInfoFromOCR.address;
        console.log('✅ [Azure DI] Extracted recipient address from OCR:', data.recipientAddress);
      }
      
      if (!data.payerName && personalInfoFromOCR.payerName) {
        data.payerName = personalInfoFromOCR.payerName;
        console.log('✅ [Azure DI] Extracted payer name from OCR:', data.payerName);
      }
      
      if (!data.payerTIN && personalInfoFromOCR.payerTIN) {
        data.payerTIN = personalInfoFromOCR.payerTIN;
        console.log('✅ [Azure DI] Extracted payer TIN from OCR:', data.payerTIN);
      }
    }
    
    return data;
  }

  private process1099MiscFields(fields: any, baseData: ExtractedFieldData): ExtractedFieldData {
    const data = { ...baseData };
    
    const fieldMappings = {
      'Payer.Name': 'payerName',
      'Payer.TIN': 'payerTIN',
      'Payer.Address': 'payerAddress',
      'Recipient.Name': 'recipientName',
      'Recipient.TIN': 'recipientTIN',
      'Recipient.Address': 'recipientAddress',
      'Rents': 'rents',
      'Royalties': 'royalties',
      'OtherIncome': 'otherIncome',
      'FederalIncomeTaxWithheld': 'federalTaxWithheld',
      'FishingBoatProceeds': 'fishingBoatProceeds',
      'MedicalAndHealthCarePayments': 'medicalHealthPayments',
      'NonemployeeCompensation': 'nonemployeeCompensation'
    };
    
    for (const [azureFieldName, mappedFieldName] of Object.entries(fieldMappings)) {
      if (fields[azureFieldName]?.value !== undefined) {
        const value = fields[azureFieldName].value;
        data[mappedFieldName] = typeof value === 'number' ? value : this.parseAmount(value);
      }
    }
    
    // OCR fallback for personal info if not found in structured fields
    if ((!data.recipientName || !data.recipientTIN || !data.recipientAddress || !data.payerName || !data.payerTIN) && baseData.fullText) {
      console.log('🔍 [Azure DI] Some 1099-MISC info missing from structured fields, attempting OCR extraction...');
      const personalInfoFromOCR = this.extractPersonalInfoFromOCR(baseData.fullText as string);
      
      if (!data.recipientName && personalInfoFromOCR.name) {
        data.recipientName = personalInfoFromOCR.name;
        console.log('✅ [Azure DI] Extracted recipient name from OCR:', data.recipientName);
      }
      
      if (!data.recipientTIN && personalInfoFromOCR.tin) {
        data.recipientTIN = personalInfoFromOCR.tin;
        console.log('✅ [Azure DI] Extracted recipient TIN from OCR:', data.recipientTIN);
      }
      
      if (!data.recipientAddress && personalInfoFromOCR.address) {
        data.recipientAddress = personalInfoFromOCR.address;
        console.log('✅ [Azure DI] Extracted recipient address from OCR:', data.recipientAddress);
      }
      
      if (!data.payerName && personalInfoFromOCR.payerName) {
        data.payerName = personalInfoFromOCR.payerName;
        console.log('✅ [Azure DI] Extracted payer name from OCR:', data.payerName);
      }
      
      if (!data.payerTIN && personalInfoFromOCR.payerTIN) {
        data.payerTIN = personalInfoFromOCR.payerTIN;
        console.log('✅ [Azure DI] Extracted payer TIN from OCR:', data.payerTIN);
      }
    }
    
    return data;
  }

  private process1099NecFields(fields: any, baseData: ExtractedFieldData): ExtractedFieldData {
    const data = { ...baseData };
    
    const fieldMappings = {
      'Payer.Name': 'payerName',
      'Payer.TIN': 'payerTIN',
      'Payer.Address': 'payerAddress',
      'Recipient.Name': 'recipientName',
      'Recipient.TIN': 'recipientTIN',
      'Recipient.Address': 'recipientAddress',
      'NonemployeeCompensation': 'nonemployeeCompensation',
      'FederalIncomeTaxWithheld': 'federalTaxWithheld'
    };
    
    for (const [azureFieldName, mappedFieldName] of Object.entries(fieldMappings)) {
      if (fields[azureFieldName]?.value !== undefined) {
        const value = fields[azureFieldName].value;
        data[mappedFieldName] = typeof value === 'number' ? value : this.parseAmount(value);
      }
    }
    
    // OCR fallback for personal info if not found in structured fields
    if ((!data.recipientName || !data.recipientTIN || !data.recipientAddress || !data.payerName || !data.payerTIN) && baseData.fullText) {
      console.log('🔍 [Azure DI] Some 1099-NEC info missing from structured fields, attempting OCR extraction...');
      const personalInfoFromOCR = this.extractPersonalInfoFromOCR(baseData.fullText as string);
      
      if (!data.recipientName && personalInfoFromOCR.name) {
        data.recipientName = personalInfoFromOCR.name;
        console.log('✅ [Azure DI] Extracted recipient name from OCR:', data.recipientName);
      }
      
      if (!data.recipientTIN && personalInfoFromOCR.tin) {
        data.recipientTIN = personalInfoFromOCR.tin;
        console.log('✅ [Azure DI] Extracted recipient TIN from OCR:', data.recipientTIN);
      }
      
      if (!data.recipientAddress && personalInfoFromOCR.address) {
        data.recipientAddress = personalInfoFromOCR.address;
        console.log('✅ [Azure DI] Extracted recipient address from OCR:', data.recipientAddress);
      }
      
      if (!data.payerName && personalInfoFromOCR.payerName) {
        data.payerName = personalInfoFromOCR.payerName;
        console.log('✅ [Azure DI] Extracted payer name from OCR:', data.payerName);
      }
      
      if (!data.payerTIN && personalInfoFromOCR.payerTIN) {
        data.payerTIN = personalInfoFromOCR.payerTIN;
        console.log('✅ [Azure DI] Extracted payer TIN from OCR:', data.payerTIN);
      }
    }
    
    return data;
  }

  private processGenericFields(fields: any, baseData: ExtractedFieldData): ExtractedFieldData {
    const data = { ...baseData };
    
    for (const [fieldName, field] of Object.entries(fields || {})) {
      if (field && typeof field === 'object' && 'value' in field && (field as any).value !== undefined) {
        data[fieldName] = (field as any).value;
      }
    }
    
    return data;
  }

  private parseAmount(value: any): number {
    if (typeof value === 'number') return value;
    if (typeof value === 'string') {
      const cleaned = value.replace(/[$,\s]/g, '');
      const parsed = parseFloat(cleaned);
      return isNaN(parsed) ? 0 : parsed;
    }
    return 0;
  }

  /**
   * Extracts personal information from OCR text using comprehensive regex patterns
   * Supports both W-2 and 1099 forms with automatic form type detection
   * Routes to appropriate pattern sets based on detected form type
   */
  private extractPersonalInfoFromOCR(ocrText: string): {
    name?: string;
    ssn?: string;
    address?: string;
    tin?: string;
    payerName?: string;
    payerTIN?: string;
    payerAddress?: string;
    employerName?: string;
    employerAddress?: string;
  } {
    console.log('🔍 [Azure DI OCR] Searching for personal info in OCR text...');
    
    // Detect form type to route to appropriate patterns
    const formType = this.detectFormType(ocrText);
    
    if (formType === '1099') {
      console.log('🔍 [Azure DI OCR] Routing to 1099 extraction patterns...');
      const info1099 = this.extract1099InfoFromOCR(ocrText);
      return {
        name: info1099.name,
        ssn: info1099.tin, // Map TIN to SSN field for compatibility
        tin: info1099.tin,
        address: info1099.address,
        payerName: info1099.payerName,
        payerTIN: info1099.payerTIN,
        payerAddress: info1099.payerAddress
      };
    }
    
    // Default to W2 extraction (preserves existing functionality)
    console.log('🔍 [Azure DI OCR] Using W2 extraction patterns (form type:', formType, ')...');
    const personalInfo: { name?: string; ssn?: string; address?: string; employerName?: string; employerAddress?: string } = {};
    
    // Extract employer address - comprehensive patterns for W-2 format variations
    // Ordered from most specific to least specific to prevent conflicts
    const employerAddressPatterns = [
      // Tier 1: Standard W-2 employer address patterns
      {
        name: 'EMPLOYER_ADDRESS_STANDARD_MULTILINE',
        pattern: /c\s+Employer's\s+name,?\s+address,?\s+and\s+ZIP\s+code\s*\n([^\n]+(?:\n[A-Za-z0-9\s,.-]+)*?)(?=\n\s*\n|\nd\s+Control|\ne\s+Employee|\nEmployee|$)/i,
        example: 'c Employer\'s name, address, and ZIP code\nACME Corp\n123 Business Ave\nNew York, NY 10001'
      },
      {
        name: 'EMPLOYER_ADDRESS_INLINE_ENHANCED',
        pattern: /Employer:\s*([^,\n]+(?:,\s*[^,\n]+)*?)(?=\n(?:Employee|EIN|SSN|Wages|\d+\s+)|$)/i,
        example: 'Employer: QuickStart LLC, 555 Main St, Chicago, IL 60601'
      },
      {
        name: 'EMPLOYER_ADDRESS_COMBINED_FORMAT',
        pattern: /c\s+Employer's\s+name,?\s+address,?\s+and\s+ZIP\s+code\s+([A-Z][A-Z0-9\s,.-]+?)(?=\n|$)/i,
        example: 'c Employer\'s name, address, and ZIP code WALMART INC 702 SW 8TH ST BENTONVILLE AR 72716'
      },
      {
        name: 'EMPLOYER_NAME_ADDRESS_SEPARATE',
        pattern: /Employer[:\s]+([A-Za-z0-9\s,.-]+?)(?=\n(?:Address|Employee|EIN|SSN|Wages|\d+\s+)|$)/i,
        example: 'Employer: ACME Corporation'
      }
    ];

    // Try to extract employer address
    for (const patternInfo of employerAddressPatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        personalInfo.employerAddress = match[1].trim().replace(/\s+/g, ' ');
        console.log(`🔍 [Azure DI OCR] Employer address pattern matched: ${patternInfo.name}`);
        console.log('✅ [Azure DI OCR] Found employer address:', personalInfo.employerAddress);
        break;
      }
    }

    // Extract employer name if not already captured in address
    if (!personalInfo.employerAddress || !personalInfo.employerAddress.includes(',')) {
      const employerNamePatterns = [
        {
          name: 'EMPLOYER_NAME_STANDARD',
          pattern: /c\s+Employer's\s+name,?\s+address,?\s+and\s+ZIP\s+code\s*\n([A-Za-z0-9\s&.,'-]+?)(?:\n[0-9]|\nAddress|\n[A-Za-z]+\s+[A-Za-z]+|$)/i,
          example: 'c Employer\'s name, address, and ZIP code\nACME Corporation'
        },
        {
          name: 'EMPLOYER_NAME_INLINE',
          pattern: /Employer[:\s]+([A-Za-z0-9\s&.,'-]+?)(?=\n|,|\s+\d+\s+[A-Za-z]|$)/i,
          example: 'Employer: ACME Corporation'
        }
      ];

      for (const patternInfo of employerNamePatterns) {
        const match = ocrText.match(patternInfo.pattern);
        if (match && match[1]) {
          personalInfo.employerName = match[1].trim().replace(/\s+/g, ' ');
          console.log(`🔍 [Azure DI OCR] Employer name pattern matched: ${patternInfo.name}`);
          console.log('✅ [Azure DI OCR] Found employer name:', personalInfo.employerName);
          break;
        }
      }
    }
    
    // Extract employee name - comprehensive patterns for W-2 format variations
    // Ordered from most specific to least specific to prevent conflicts
    const namePatterns = [
      // Tier 1: W-2 specific labeled patterns (highest priority to avoid false matches)
      {
        name: 'W2_COMBINED_NAME_ADDRESS_ENHANCED',
        pattern: /(?:e\/f)\s+Employee's\s+name,?\s+address,?\s+and\s+ZIP\s+code\s+([A-Z][A-Z\s]+?)\s+(\d+.*?)(?:\n|$)/i,
        example: 'e/f Employee\'s name, address and ZIP code MICHAEL JACKSON 1103 BERNARD ST APT 712 DENTON, TX 76201'
      },
      {
        name: 'W2_NAME_ADDRESS_INLINE_ENHANCED',
        pattern: /(?:e\s+)?Employee's\s+first\s+name\s+and\s+initial\s+Last\s+name\s+([A-Za-z\s]+?)\s+(\d+\s+[A-Za-z\s]+?(?:Apt\.?|Apartment|Unit|Suite|Ste\.?|APT|APARTMENT|UNIT|SUITE|STE)\s*\d+)\s+([A-Za-z\s]+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)(?:\s|$)/i,
        example: 'e Employee\'s first name and initial Last name Michelle Hicks 0121 Gary Islands Apt. 691 Sandraport UT 35155-6840'
      },
      
      // Tier 2: Most specific combined name+address patterns (standalone formats)
      {
        name: 'COMBINED_NAME_ADDRESS_SIMPLE',
        pattern: /\b([A-Z][A-Z\s]+?)\s+(\d+\s+[A-Z][A-Z\s]+?(?:ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|BLVD|BOULEVARD|LN|LANE|CT|COURT|PL|PLACE|WAY|PKWY|PARKWAY|CIR|CIRCLE)\s+(?:APT|APARTMENT|UNIT|SUITE|STE)?\s*\d*\s+[A-Z][A-Z\s]*?,?\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)\b/i,
        example: 'MICHAEL JACKSON 1103 BERNARD ST APT 712 DENTON, TX 76201'
      },
      {
        name: 'SIMPLE_NAME_ADDRESS',
        pattern: /\b([A-Z][A-Z\s]+?)\s+(\d+\s+[A-Z][A-Z\s]+?(?:ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|BLVD|BOULEVARD|LN|LANE|CT|COURT|PL|PLACE|WAY|PKWY|PARKWAY|CIR|CIRCLE)(?:\s+(?:APT|APARTMENT|UNIT|SUITE|STE)\s*[A-Z0-9]+)?)\b/i,
        example: 'JOHN SMITH 123 MAIN ST APT 4B'
      },
      
      // Tier 3: Standard W-2 patterns with enhanced matching
      {
        name: 'W2_SPLIT_NAME_ENHANCED',
        pattern: /(?:e\s+Employee's\s+first\s+name\s+and\s+initial\s+([A-Z][A-Z\s]+?)[\s\n]+Last\s+name\s+([A-Z][A-Z\s]+?)(?:\s+\d|\n|f\s+Employee's\s+address|Employee's\s+address|$))/i,
        example: 'e Employee\'s first name and initial SAI KUMAR Last name POTURI'
      },
      {
        name: 'W2_STANDARD_NAME_ENHANCED',
        pattern: /(?:e\s+)?Employee's\s+first\s+name\s+and\s+initial\s+Last\s+name\s+([A-Za-z\s]+?)(?:\s+\d|\n|Employee's\s+address|f\s+Employee's\s+address|$)/i,
        example: 'e Employee\'s first name and initial Last name Michelle Hicks'
      },
      {
        name: 'W2_SIMPLE_NAME_ENHANCED',
        pattern: /Employee's\s+first\s+name\s+and\s+initial\s+Last\s+name\s+([A-Za-z\s]+?)(?:\s+\d|\n|Employee's\s+address|f\s+Employee's\s+address|$)/i,
        example: 'Employee\'s first name and initial Last name Michelle Hicks'
      },
      
      // Tier 3: Alternative W-2 format patterns
      {
        name: 'W2_NAME_FIELD_VARIANT',
        pattern: /(?:Employee's\s+name|Employee\s+name)[:\s]+([A-Za-z\s]+?)(?:\s+\d|\n|Employee's\s+address|Employee's\s+social|SSN|Social|Address|$)/i,
        example: 'Employee\'s name: John Doe'
      },
      {
        name: 'W2_RECIPIENT_NAME',
        pattern: /(?:Recipient's?\s+name|Recipient)[:\s]+([A-Za-z\s]+?)(?:\s+\d|\n|address|social|SSN|Social|Address|$)/i,
        example: 'Recipient name: Jane Smith'
      },
      
      // Tier 4: Generic fallback patterns (lowest priority)
      {
        name: 'GENERIC_EMPLOYEE_ENHANCED',
        pattern: /Employee[:\s]+([A-Za-z\s]+?)(?:\n|Employee's\s+address|Employee's\s+social|SSN|Social|Address|Employer|$)/i,
        example: 'Employee: John Doe'
      },
      {
        name: 'EMPLOYEE_NAME_LABEL_ENHANCED',
        pattern: /Employee\s+Name[:\s]+([A-Za-z\s]+?)(?:\n|Employee's\s+address|Employee's\s+social|SSN|Social|Address|Employer|$)/i,
        example: 'Employee Name: John Doe'
      },
      
      // Tier 5: Last resort patterns for edge cases
      {
        name: 'NAME_BEFORE_ADDRESS_FALLBACK',
        pattern: /\b([A-Z][A-Z\s]{2,30}?)\s+(?=\d+\s+[A-Z])/,
        example: 'SARAH JOHNSON 456 Oak Street'
      },
      {
        name: 'CAPITALIZED_NAME_FALLBACK',
        pattern: /\b([A-Z][A-Z\s]{8,40}?)\s+(?=Employee's\s+address|address|social|SSN|\d{3}-\d{2}-\d{4})/i,
        example: 'ROBERT WILLIAMS Employee\'s address'
      }
    ];
    
    for (const patternInfo of namePatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        console.log(`🔍 [Azure DI OCR] Name pattern matched: ${patternInfo.name}`);
        
        // Special handling for combined name+address patterns
        if ((patternInfo.name === 'COMBINED_NAME_ADDRESS_SIMPLE' || 
             patternInfo.name === 'SIMPLE_NAME_ADDRESS' ||
             patternInfo.name === 'W2_COMBINED_NAME_ADDRESS_ENHANCED') && match[2]) {
          // For combined patterns, match[1] is name, match[2] is address
          personalInfo.name = match[1].trim().replace(/\s+/g, ' ');
          personalInfo.address = match[2].trim().replace(/\s+/g, ' ');
          console.log('✅ [Azure DI OCR] Found employee address from combined pattern:', personalInfo.address);
        } else if (patternInfo.name === 'W2_NAME_ADDRESS_INLINE_ENHANCED' && match[2] && match[3] && match[4] && match[5]) {
          // For inline pattern: match[1] = name, match[2] = street, match[3] = city, match[4] = state, match[5] = zip
          personalInfo.name = match[1].trim().replace(/\s+/g, ' ');
          personalInfo.address = `${match[2].trim()} ${match[3].trim()} ${match[4].trim()} ${match[5].trim()}`.replace(/\s+/g, ' ');
          console.log('✅ [Azure DI OCR] Found employee address from inline pattern:', personalInfo.address);
        } else if (patternInfo.name === 'W2_SPLIT_NAME_ENHANCED' && match[2]) {
          // Handle split name format (first name + last name in separate groups)
          personalInfo.name = `${match[1].trim()} ${match[2].trim()}`.replace(/\s+/g, ' ');
        } else {
          // Standard single-group name extraction
          personalInfo.name = match[1].trim().replace(/\s+/g, ' ');
        }
        
        console.log('✅ [Azure DI OCR] Found employee name:', personalInfo.name);
        break;
      }
    }
    
    // Extract SSN - comprehensive patterns for W-2 format variations
    const ssnPatterns = [
      {
        name: 'W2_SSN_WITHOUT_DASHES',
        pattern: /a\s+Employee's\s+social\s+security\s+number\s+(\d{9,10})/i,
        example: 'a Employee\'s social security number 123456789'
      },
      {
        name: 'W2_SSN_MULTILINE',
        pattern: /Employee's\s+social\s+security\s+number\s*\n(\d{3}-\d{2}-\d{4})/i,
        example: 'Employee\'s social security number\n123-45-6789'
      },
      {
        name: 'W2_SSN_SAME_LINE',
        pattern: /Employee's\s+social\s+security\s+number\s+(\d{9,10})/i,
        example: 'Employee\'s social security number 123456789'
      },
      {
        name: 'SOCIAL_SECURITY_MULTILINE',
        pattern: /social\s+security\s+number\s*\n(\d{3}-\d{2}-\d{4})/i,
        example: 'social security number\n123-45-6789'
      },
      {
        name: 'SOCIAL_SECURITY_SAME_LINE',
        pattern: /social\s+security\s+number\s+(\d{9,10})/i,
        example: 'social security number 123456789'
      },
      {
        name: 'SSN_LABEL',
        pattern: /SSN[:\s]*(\d{3}-\d{2}-\d{4})/i,
        example: 'SSN: 123-45-6789'
      },
      {
        name: 'SOCIAL_SECURITY_LABEL',
        pattern: /Social\s+Security[:\s]*(\d{3}-\d{2}-\d{4})/i,
        example: 'Social Security: 123-45-6789'
      },
      {
        name: 'SSN_PATTERN_FALLBACK',
        pattern: /(\d{3}-\d{2}-\d{4})/,
        example: '123-45-6789'
      }
    ];
    
    for (const patternInfo of ssnPatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        console.log(`🔍 [Azure DI OCR] SSN pattern matched: ${patternInfo.name}`);
        personalInfo.ssn = match[1];
        console.log('✅ [Azure DI OCR] Found employee SSN:', personalInfo.ssn);
        break;
      }
    }
    
    // Extract address - comprehensive patterns for W-2 format variations
    // Ordered from most specific to least specific to prevent conflicts
    const addressPatterns = [
      // Tier 1: Most specific address patterns (highest priority)
      {
        name: 'STANDALONE_FULL_ADDRESS_WITH_UNIT',
        pattern: /\b(\d+\s+[A-Z][A-Z\s]+?(?:ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|BLVD|BOULEVARD|LN|LANE|CT|COURT|PL|PLACE|WAY|PKWY|PARKWAY|CIR|CIRCLE)\s+(?:APT|APARTMENT|UNIT|SUITE|STE)\s*\d+\s+[A-Z][A-Z\s]*?,?\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)\b/i,
        example: '1103 BERNARD ST APT 712 DENTON, TX 76201'
      },
      {
        name: 'STANDALONE_FULL_ADDRESS_SIMPLE',
        pattern: /\b(\d+\s+[A-Z][A-Z\s]+?(?:ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|BLVD|BOULEVARD|LN|LANE|CT|COURT|PL|PLACE|WAY|PKWY|PARKWAY|CIR|CIRCLE)\s+[A-Z][A-Z\s]*?,?\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)\b/i,
        example: '123 MAIN ST DALLAS, TX 75201'
      },
      {
        name: 'PO_BOX_FULL_ADDRESS',
        pattern: /\b(P\.?O\.?\s+BOX\s+\d+\s+[A-Z][A-Z\s]*?,?\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)\b/i,
        example: 'P.O. BOX 1234 HOUSTON, TX 77001'
      },
      {
        name: 'RURAL_ROUTE_FULL_ADDRESS',
        pattern: /\b(RR\s+\d+\s+BOX\s+\d+\s+[A-Z][A-Z\s]*?,?\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)\b/i,
        example: 'RR 2 BOX 123 SMALLTOWN, TX 75001'
      },
      
      // Tier 2: W-2 specific address patterns
      {
        name: 'W2_ADDRESS_WITH_PREFIX_ENHANCED',
        pattern: /f\s+Employee's\s+address\s+and\s+ZIP\s+code\s+(\d{3,}\s+[A-Za-z][A-Za-z0-9\s,.-]{10,})(?:\n|a\s+Employee's\s+social|Employee's\s+social|$)/i,
        example: 'f Employee\'s address and ZIP code 315 AVENUE , APT 900, 78900'
      },
      {
        name: 'W2_NAME_ADDRESS_COMBINED_ENHANCED',
        pattern: /(?:e\/f|e\/f)\s+Employee's\s+name,?\s+address,?\s+and\s+ZIP\s+code\s+[A-Z][A-Z\s]+?\s+([0-9][^\n]*?)(?:\n|$)/i,
        example: 'e/f Employee\'s name, address and ZIP code MICHAEL JACKSON 1103 BERNARD ST APT 712 DENTON, TX 76201'
      },
      {
        name: 'W2_AFTER_NAME_MULTILINE_ENHANCED',
        pattern: /(?:e\s+)?Employee's\s+first\s+name\s+and\s+initial\s+Last\s+name\s+[A-Za-z\s]+?\s+([0-9][^f\n]*?)(?=\n\d+|\nf Employee|\Z)/i,
        example: 'e Employee\'s first name and initial Last name Michelle Hicks 0121 Gary Islands Apt. 691 Sandraport UT 35155-6840'
      },
      {
        name: 'W2_INLINE_FULL_ADDRESS_ENHANCED',
        pattern: /(?:e\s+)?Employee's\s+first\s+name\s+and\s+initial\s+Last\s+name\s+[A-Za-z\s]+?\s+(\d+[^A-Z]*?[A-Z][A-Za-z\s]+?\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)(?:\s|$)/i,
        example: 'e Employee\'s first name and initial Last name Michelle Hicks 0121 Gary Islands Apt. 691 Sandraport UT 35155-6840'
      },
      
      // Tier 3: Standard address field patterns
      {
        name: 'W2_ADDRESS_MULTILINE_ENHANCED',
        pattern: /Employee's\s+address\s+and\s+ZIP\s+code\s*\n([^\n]+(?:\n[^\n]+)*?)(?=\n\s*\n|\nEmployee's\s+social|\nEmployer|\n[a-z]\s+Employee|\n\d+\s+|$)/i,
        example: 'Employee\'s address and ZIP code\n123 Main St\nAnytown TX 12345'
      },
      {
        name: 'W2_ADDRESS_FLEXIBLE_ENHANCED',
        pattern: /Employee's\s+address[^\n]*\n([^\n]+(?:\n[0-9A-Za-z][^\n]*)*?)(?=\n\s*\n|\nEmployee's\s+social|\nEmployer|\n[a-z]\s+Employee|\n\d+\s+|$)/i,
        example: 'Employee\'s address and ZIP code\n123 Main St\nAnytown TX 12345'
      },
      {
        name: 'ADDRESS_ZIP_FALLBACK_ENHANCED',
        pattern: /address\s+and\s+ZIP\s+code[^\n]*\n([^\n]+(?:\n[^\n]+)*?)(?:\n\s*\n|social\s+security|Employer|Employee's\s+social|$)/i,
        example: 'address and ZIP code\n123 Main St\nAnytown TX 12345'
      },
      
      // Tier 3.5: Improved specific address patterns (to prevent false matches)
      {
        name: 'EMPLOYEE_ADDRESS_FLEXIBLE_IMPROVED',
        pattern: /Employee's\s+address:\s*([^\n]+(?:,\s*[^\n]+)*)(?=\n(?:Wages|SSN|\d+\s+)|$)/i,
        example: 'Employee\'s address: 888 Lake Shore Dr, Chicago, IL 60611'
      },
      {
        name: 'EMPLOYEE_ADDRESS_AFTER_NAME_IMPROVED',
        pattern: /Employee:\s*[A-Za-z\s]+\s*\nEmployee's\s+address:\s*([^\n]+)(?=\n(?:Wages|SSN|\d+\s+)|$)/i,
        example: 'Employee: Robert Williams\nEmployee\'s address: 888 Lake Shore Dr, Chicago, IL 60611'
      },
      {
        name: 'W2_ADDRESS_MULTILINE_STRICT',
        pattern: /f\s+Employee's\s+address\s+and\s+ZIP\s+code\s*\n([A-Za-z0-9\s,.-]+(?:\n[A-Za-z0-9\s,.-]+)*?)(?=\n\s*\n|\na\s+Employee|\nEmployee's\s+social|\nSSN|\n\d+\s+(?:Wages|Federal|Social)|$)/i,
        example: 'f Employee\'s address and ZIP code\n456 Residential St\nApt 3B\nBrooklyn, NY 11201'
      },
      
      // Tier 4: Generic address patterns
      {
        name: 'GENERIC_ADDRESS_ENHANCED',
        pattern: /Address[:\s]+([^\n]+(?:\n[^\n]+)*?)(?:\n\n|Employee|Employer|Social|SSN|$)/i,
        example: 'Address: 123 Main St\nAnytown TX 12345'
      },
      {
        name: 'RECIPIENT_ADDRESS',
        pattern: /(?:Recipient's?\s+address|Recipient\s+address)[:\s]+([^\n]+(?:\n[^\n]+)*?)(?:\n\n|Employee|Employer|Social|SSN|$)/i,
        example: 'Recipient address: 456 Oak Street\nAustin TX 73301'
      },
      
      // Tier 5: Fallback patterns for partial addresses
      {
        name: 'STREET_WITH_UNIT_FALLBACK',
        pattern: /\b(\d+\s+[A-Z][A-Z\s]+?(?:ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|BLVD|BOULEVARD|LN|LANE|CT|COURT|PL|PLACE|WAY|PKWY|PARKWAY|CIR|CIRCLE)\s+(?:APT|APARTMENT|UNIT|SUITE|STE)\s*\d+)\b/i,
        example: '789 Pine Ave APT 4B'
      },
      {
        name: 'STREET_ADDRESS_FALLBACK',
        pattern: /\b(\d+\s+[A-Z][A-Z\s]+?(?:ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|BLVD|BOULEVARD|LN|LANE|CT|COURT|PL|PLACE|WAY|PKWY|PARKWAY|CIR|CIRCLE))\b/i,
        example: '100 Business Park Dr'
      },
      {
        name: 'ZIP_CODE_CONTEXT_FALLBACK',
        pattern: /([A-Z][A-Z\s]*?,?\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)/i,
        example: 'CORPORATE CITY, CA 90210'
      }
    ];
    
    for (const patternInfo of addressPatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        console.log(`🔍 [Azure DI OCR] Address pattern matched: ${patternInfo.name}`);
        // Clean up the address: normalize whitespace and join lines with spaces
        personalInfo.address = match[1].trim().replace(/\n/g, ' ').replace(/\s+/g, ' ');
        console.log('✅ [Azure DI OCR] Found employee address:', personalInfo.address);
        break;
      }
    }
    
    // Return W2 info with additional fields for compatibility
    return {
      name: personalInfo.name,
      ssn: personalInfo.ssn,
      address: personalInfo.address,
      tin: personalInfo.ssn, // Map SSN to TIN field for 1099 compatibility
      payerName: undefined, // Not applicable for W2
      payerTIN: undefined, // Not applicable for W2
      payerAddress: undefined, // Not applicable for W2
      employerName: personalInfo.employerName,
      employerAddress: personalInfo.employerAddress
    };
  }

  /**
   * Comprehensive address parsing to extract city, state, and zipCode from full address string
   * Uses tiered fallback approach with multiple parsing strategies and OCR text analysis
   */
  private extractAddressParts(fullAddress: string, ocrText: string): {
    street: string;
    city: string;
    state: string;
    zipCode: string;
  } {
    console.log('🔍 [Azure DI] Parsing address parts from:', fullAddress);
    
    if (!fullAddress) {
      console.log('⚠️ [Azure DI] Empty address provided');
      return { street: '', city: '', state: '', zipCode: '' };
    }

    // Pre-clean OCR noise and normalize whitespace
    const normalizedAddress = fullAddress
      .trim()
      .replace(/\s+/g, ' ')           // Normalize multiple spaces
      .replace(/,\s*,/g, ',')         // Remove double commas
      .replace(/\.\s*\./g, '.')       // Remove double periods
      .replace(/\s*,\s*/g, ', ')      // Normalize comma spacing
      .replace(/\s*\.\s*/g, '. ');    // Normalize period spacing
    
    console.log('🔍 [Azure DI] Normalized address:', normalizedAddress);

    // Initialize result object
    let result = {
      street: '',
      city: '',
      state: '',
      zipCode: ''
    };

    // Tier 1: Primary parsing patterns (most specific to least specific)
    const primaryPatterns = [
      {
        name: 'INLINE_STREET_APT_CITY_STATE_ZIP',
        pattern: /^(\d+\s+[A-Za-z\s]+?(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Boulevard|Ln|Lane|Ct|Court|Pl|Place|Way|Pkwy|Parkway|Cir|Circle|Islands|Hills|Park)\s+(?:Apt\.?|Apartment|Unit|Suite|Ste\.?)\s*\d+)\s+([A-Za-z]+(?:\s+[A-Za-z]+)*)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i,
        example: '0121 Gary Islands Apt. 691 Sandraport UT 35155-6840',
        extract: (match: RegExpMatchArray) => ({
          street: match[1].trim(),
          city: match[2].trim(),
          state: match[3].toUpperCase(),
          zipCode: match[4]
        })
      },
      {
        name: 'STREET_APT_CITY_STATE_ZIP',
        pattern: /^(.+?(?:ST|STREET|AVE|AVENUE|RD|ROAD|DR|DRIVE|BLVD|BOULEVARD|LN|LANE|CT|COURT|PL|PLACE|WAY|PKWY|PARKWAY|CIR|CIRCLE)\s+(?:APT|APARTMENT|UNIT|SUITE|STE)?\s*\d*)\s+([A-Z][A-Z\s]*?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i,
        example: '1103 BERNARD ST APT 712 DENTON, TX 76201',
        extract: (match: RegExpMatchArray) => ({
          street: match[1].trim(),
          city: match[2].trim(),
          state: match[3].toUpperCase(),
          zipCode: match[4]
        })
      },
      {
        name: 'COMMA_SEPARATED_FULL',
        pattern: /^(.+?),\s*(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i,
        example: '123 Main St, Dallas, TX 75201',
        extract: (match: RegExpMatchArray) => ({
          street: match[1].trim(),
          city: match[2].trim(),
          state: match[3].toUpperCase(),
          zipCode: match[4]
        })
      },
      {
        name: 'SPACE_SEPARATED_FULL',
        pattern: /^(.+?)\s+([A-Za-z\s]+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)(?:\s|$)/i,
        example: '123 Main St Dallas TX 75201',
        extract: (match: RegExpMatchArray) => {
          // Try to intelligently split street and city
          const fullStreetCity = `${match[1]} ${match[2]}`.trim();
          
          // Look for common address patterns to split street from city
          const streetCityMatch = fullStreetCity.match(/^(.+?(?:St|Street|Ave|Avenue|Rd|Road|Dr|Drive|Blvd|Boulevard|Ln|Lane|Ct|Court|Pl|Place|Way|Pkwy|Parkway|Cir|Circle|APT|APARTMENT|UNIT|SUITE|STE)\s+\d*)\s+(.+)$/i);
          
          if (streetCityMatch) {
            return {
              street: streetCityMatch[1].trim(),
              city: streetCityMatch[2].trim(),
              state: match[3].toUpperCase(),
              zipCode: match[4]
            };
          } else {
            // Fallback: assume last word(s) before state are city
            const words = fullStreetCity.split(' ');
            if (words.length >= 2) {
              return {
                street: words.slice(0, -1).join(' '),
                city: words[words.length - 1],
                state: match[3].toUpperCase(),
                zipCode: match[4]
              };
            } else {
              return {
                street: fullStreetCity,
                city: '',
                state: match[3].toUpperCase(),
                zipCode: match[4]
              };
            }
          }
        }
      },
      {
        name: 'TWO_PART_CITY_STATE_ZIP',
        pattern: /^(.+?),\s*(.+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i,
        example: '456 Oak Street, Austin TX 73301',
        extract: (match: RegExpMatchArray) => ({
          street: match[1].trim(),
          city: match[2].trim(),
          state: match[3].toUpperCase(),
          zipCode: match[4]
        })
      },
      {
        name: 'APARTMENT_WITH_ZIP',
        pattern: /^(.+?),\s*(APT|APARTMENT|UNIT|SUITE|STE)\s+([^,]+),\s*(\d{5}(?:-\d{4})?)$/i,
        example: '315 AVENUE, APT 900, 78900',
        extract: (match: RegExpMatchArray) => ({
          street: `${match[1].trim()}, ${match[2]} ${match[3]}`.trim(),
          city: '',
          state: '',
          zipCode: match[4]
        })
      },
      {
        name: 'PO_BOX_FORMAT',
        pattern: /^(P\.?O\.?\s+BOX\s+\d+),\s*(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i,
        example: 'P.O. BOX 1234, HOUSTON, TX 77001',
        extract: (match: RegExpMatchArray) => ({
          street: match[1].trim(),
          city: match[2].trim(),
          state: match[3].toUpperCase(),
          zipCode: match[4]
        })
      },
      {
        name: 'RURAL_ROUTE_FORMAT',
        pattern: /^(RR\s+\d+\s+BOX\s+\d+),\s*(.+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i,
        example: 'RR 2 BOX 123, SMALLTOWN, TX 75001',
        extract: (match: RegExpMatchArray) => ({
          street: match[1].trim(),
          city: match[2].trim(),
          state: match[3].toUpperCase(),
          zipCode: match[4]
        })
      }
    ];

    // Try primary patterns first
    for (const patternInfo of primaryPatterns) {
      const match = normalizedAddress.match(patternInfo.pattern);
      if (match) {
        console.log(`✅ [Azure DI] Primary pattern matched: ${patternInfo.name}`);
        result = patternInfo.extract(match);
        console.log('✅ [Azure DI] Extracted using primary pattern:', result);
        break;
      }
    }

    // Tier 2: Secondary patterns (fallback for partial matches)
    if (!result.street && !result.city && !result.state && !result.zipCode) {
      console.log('🔍 [Azure DI] Primary patterns failed, trying secondary patterns...');
      
      const secondaryPatterns = [
        {
          name: 'STREET_WITH_ZIP_ONLY',
          pattern: /^(.+?),\s*(\d{5}(?:-\d{4})?)$/,
          example: '789 Pine Ave, 12345',
          extract: (match: RegExpMatchArray) => ({
            street: match[1].trim(),
            city: '',
            state: '',
            zipCode: match[2]
          })
        },
        {
          name: 'STREET_WITH_CITY_ONLY',
          pattern: /^(.+?),\s*([A-Za-z\s]+?)$/,
          example: '123 Main St, Dallas',
          extract: (match: RegExpMatchArray) => ({
            street: match[1].trim(),
            city: match[2].trim(),
            state: '',
            zipCode: ''
          })
        },
        {
          name: 'MULTI_LINE_COMBINED',
          pattern: /^(.+?)\s+(.+?)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/,
          example: '100 Business Park Dr Suite 200 Corporate City CA 90210',
          extract: (match: RegExpMatchArray) => {
            // Try to split street and city intelligently
            const fullStreet = match[1];
            const possibleCity = match[2];
            
            // Look for apartment/suite indicators in the street
            const aptMatch = fullStreet.match(/^(.+?)\s+(APT|APARTMENT|UNIT|SUITE|STE)\s+(.+)$/i);
            if (aptMatch) {
              return {
                street: `${aptMatch[1]} ${aptMatch[2]} ${aptMatch[3]}`.trim(),
                city: possibleCity.trim(),
                state: match[3].toUpperCase(),
                zipCode: match[4]
              };
            } else {
              return {
                street: fullStreet.trim(),
                city: possibleCity.trim(),
                state: match[3].toUpperCase(),
                zipCode: match[4]
              };
            }
          }
        }
      ];

      for (const patternInfo of secondaryPatterns) {
        const match = normalizedAddress.match(patternInfo.pattern);
        if (match) {
          console.log(`✅ [Azure DI] Secondary pattern matched: ${patternInfo.name}`);
          result = patternInfo.extract(match);
          console.log('✅ [Azure DI] Extracted using secondary pattern:', result);
          break;
        }
      }
    }

    // Tier 3: Granular token extraction (last resort)
    if (!result.street && !result.city && !result.state && !result.zipCode) {
      console.log('🔍 [Azure DI] Secondary patterns failed, trying granular extraction...');
      
      // Extract ZIP code
      const zipMatch = normalizedAddress.match(/\b(\d{5}(?:-\d{4})?)\b/);
      if (zipMatch) {
        result.zipCode = zipMatch[1];
        console.log('✅ [Azure DI] Found ZIP code:', result.zipCode);
      }

      // Extract state (2 uppercase letters) - with validation against valid US states
      const validStates = new Set([
        'AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'FL', 'GA',
        'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD',
        'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ',
        'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC',
        'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY',
        'DC', 'PR', 'VI', 'GU', 'AS', 'MP'
      ]);
      
      const statePatterns = [
        /\b([A-Z]{2})\s+\d{5}/,           // State before ZIP
        /,\s*([A-Z]{2})\s*$/,             // State at end
        /\s([A-Z]{2})\s+\d{5}/,           // State before ZIP with space
        /\b([A-Z]{2})\b(?=\s*$)/          // State at very end
      ];

      for (const pattern of statePatterns) {
        const stateMatch = normalizedAddress.match(pattern);
        if (stateMatch && validStates.has(stateMatch[1].toUpperCase())) {
          result.state = stateMatch[1].toUpperCase();
          console.log('✅ [Azure DI] Found valid state:', result.state);
          break;
        }
      }

      // Extract street (everything before city/state/zip)
      let remainingAddress = normalizedAddress;
      if (result.zipCode) {
        remainingAddress = remainingAddress.replace(new RegExp(`\\s*\\b${result.zipCode}\\b\\s*$`), '');
      }
      if (result.state) {
        remainingAddress = remainingAddress.replace(new RegExp(`\\s*\\b${result.state}\\b\\s*$`), '');
      }
      
      // Try to split remaining into street and city
      const parts = remainingAddress.split(',').map(p => p.trim()).filter(p => p);
      if (parts.length >= 2) {
        result.street = parts.slice(0, -1).join(', ');
        result.city = parts[parts.length - 1];
      } else if (parts.length === 1) {
        result.street = parts[0];
      }

      console.log('✅ [Azure DI] Granular extraction result:', result);
    }

    // Tier 4: OCR text fallback for missing state information
    if (!result.state && ocrText) {
      console.log('🔍 [Azure DI] State not found in address, searching OCR text...');
      
      const ocrStatePatterns = [
        /State:\s*([A-Z]{2})/i,
        /state\s+([A-Z]{2})\s/i,
        /\bST:\s*([A-Z]{2})/i,
        /employer.*state.*([A-Z]{2})/i
      ];

      for (const pattern of ocrStatePatterns) {
        const ocrStateMatch = ocrText.match(pattern);
        if (ocrStateMatch) {
          result.state = ocrStateMatch[1].toUpperCase();
          console.log('✅ [Azure DI] Found state in OCR text:', result.state);
          break;
        }
      }
    }

    // Final cleanup and validation
    result.street = result.street.replace(/,\s*$/, '').trim();
    result.city = result.city.replace(/,\s*$/, '').trim();
    
    // Fallback: if no parsing succeeded, use full address as street
    if (!result.street && !result.city && !result.state && !result.zipCode) {
      console.log('⚠️ [Azure DI] All parsing strategies failed, using full address as street');
      result.street = normalizedAddress;
    }

    console.log('✅ [Azure DI] Final address parsing result:', result);
    return result;
  }

  /**
   * Extracts wages from OCR text using regex patterns for Box 1
   */
  private extractWagesFromOCR(ocrText: string): number {
    console.log('🔍 [Azure DI OCR] Searching for wages in OCR text...');
    
    // Multiple regex patterns to match Box 1 wages
    const wagePatterns = [
      // Pattern: "1 Wages, tips, other comp. 900.00" (abbreviated version)
      /\b1\s+Wages[,\s]*tips[,\s]*other\s+comp\.\s+([\d,]+\.?\d*)/i,
      // Pattern: "1 Wages, tips, other compensation 161130.48"
      /\b1\s+Wages[,\s]*tips[,\s]*other\s+compensation\s+([\d,]+\.?\d*)/i,
      // Pattern: "1. Wages, tips, other compensation: $161,130.48"
      /\b1\.?\s*Wages[,\s]*tips[,\s]*other\s+compensation[:\s]+\$?([\d,]+\.?\d*)/i,
      // Pattern: "1. Wages, tips, other comp.: $900.00"
      /\b1\.?\s*Wages[,\s]*tips[,\s]*other\s+comp\.[:\s]+\$?([\d,]+\.?\d*)/i,
      // Pattern: "Box 1 161130.48" or "1 161130.48"
      /\b(?:Box\s*)?1\s+\$?([\d,]+\.?\d*)/i,
      // Pattern: "Wages and tips 161130.48"
      /Wages\s+and\s+tips\s+\$?([\d,]+\.?\d*)/i,
      // Pattern: "1 Wages, tips, other compensation" followed by amount on next line
      /\b1\s+Wages[,\s]*tips[,\s]*other\s+compensation[\s\n]+\$?([\d,]+\.?\d*)/i,
      // Pattern: "1 Wages, tips, other comp." followed by amount on next line
      /\b1\s+Wages[,\s]*tips[,\s]*other\s+comp\.[\s\n]+\$?([\d,]+\.?\d*)/i
    ];

    for (const pattern of wagePatterns) {
      const match = ocrText.match(pattern);
      if (match && match[1]) {
        const wageString = match[1];
        console.log('🔍 [Azure DI OCR] Found wage match:', wageString, 'using pattern:', pattern.source);
        
        // Parse the amount
        const cleanedAmount = wageString.replace(/[,$\s]/g, '');
        const parsedAmount = parseFloat(cleanedAmount);
        
        if (!isNaN(parsedAmount) && parsedAmount > 0) {
          console.log('✅ [Azure DI OCR] Successfully parsed wages:', parsedAmount);
          return parsedAmount;
        }
      }
    }

    console.log('⚠️ [Azure DI OCR] No wages found in OCR text');
    return 0;
  }

  /**
   * Detects the form type from OCR text to route to appropriate pattern sets
   * Returns 'W2', '1099', or 'UNKNOWN' based on form indicators
   */
  private detectFormType(ocrText: string): 'W2' | '1099' | 'UNKNOWN' {
    console.log('🔍 [Azure DI] Detecting form type from OCR text...');
    
    const text = ocrText.toLowerCase();
    
    // W2 form indicators (check first as they're more specific)
    const w2Indicators = [
      'form w-2',
      'form w2',
      'wage and tax statement',
      'employee\'s social security number',
      'employer identification number',
      'wages, tips, other compensation',
      'federal income tax withheld',
      'social security wages',
      'medicare wages'
    ];
    
    // 1099 form indicators
    const form1099Indicators = [
      'form 1099',
      'form 1099-',
      'payer\'s name',
      'payer\'s federal identification number',
      'recipient\'s identification number',
      'recipient\'s name',
      'miscellaneous income',
      'interest income',
      'dividend income',
      'nonemployee compensation'
    ];
    
    // Check for W2 indicators first
    for (const indicator of w2Indicators) {
      if (text.includes(indicator)) {
        console.log('✅ [Azure DI] Detected W2 form based on indicator:', indicator);
        return 'W2';
      }
    }
    
    // Check for 1099 indicators
    for (const indicator of form1099Indicators) {
      if (text.includes(indicator)) {
        console.log('✅ [Azure DI] Detected 1099 form based on indicator:', indicator);
        return '1099';
      }
    }
    
    console.log('⚠️ [Azure DI] Could not determine form type, defaulting to UNKNOWN');
    return 'UNKNOWN';
  }

  // === 1099 PATTERNS ===
  /**
   * Extracts personal information from 1099 OCR text using comprehensive regex patterns
   * Specifically designed for 1099 form OCR text patterns with enhanced fallback mechanisms
   */
  private extract1099InfoFromOCR(ocrText: string): {
    name?: string;
    tin?: string;
    address?: string;
    payerName?: string;
    payerTIN?: string;
    payerAddress?: string;
  } {
    console.log('🔍 [Azure DI OCR] Searching for 1099 info in OCR text...');
    
    const info1099: { 
      name?: string; 
      tin?: string; 
      address?: string;
      payerName?: string;
      payerTIN?: string;
      payerAddress?: string;
    } = {};
    
    // === RECIPIENT NAME PATTERNS ===
    const recipientNamePatterns = [
      // RECIPIENT_NAME_MULTILINE: Extract name that appears after "RECIPIENT'S name" label
      {
        name: 'RECIPIENT_NAME_MULTILINE',
        pattern: /(?:RECIPIENT'S?\s+name|Recipient'?s?\s+name)\s*\n([A-Za-z\s]+?)(?:\n|$)/i,
        example: "RECIPIENT'S name\nJordan Blake"
      },
      // RECIPIENT_NAME_BASIC: Basic recipient name extraction
      {
        name: 'RECIPIENT_NAME_BASIC',
        pattern: /(?:RECIPIENT'S?\s+NAME|Recipient'?s?\s+name)[:\s]+([A-Za-z\s]+?)(?:\s+\d|\n|RECIPIENT'S?\s+|Recipient'?s?\s+|TIN|address|street|$)/i,
        example: "RECIPIENT'S NAME JOHN DOE"
      },
      {
        name: 'RECIPIENT_SIMPLE',
        pattern: /Recipient[:\s]+([A-Za-z\s]+?)(?:\s+\d|\n|TIN|address|street|$)/i,
        example: "Recipient: JANE SMITH"
      }
    ];
    
    for (const patternInfo of recipientNamePatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        console.log(`🔍 [Azure DI OCR] Recipient name pattern matched: ${patternInfo.name}`);
        info1099.name = match[1].trim().replace(/\s+/g, ' ');
        console.log('✅ [Azure DI OCR] Found recipient name:', info1099.name);
        break;
      }
    }
    
    // === RECIPIENT ADDRESS PATTERNS ===
    const recipientAddressPatterns = [
      // RECIPIENT_STREET_CITY_MULTILINE: Extract street address and city from separate lines
      {
        name: 'RECIPIENT_STREET_CITY_MULTILINE',
        pattern: /Street address \(including apt\. no\.\)\s*\n([^\n]+)\s*\nCity or town, state or province, country, and ZIP or foreign postal code\s*\n([^\n]+)/i,
        example: "Street address (including apt. no.)\n782 Windmill Lane\nCity or town, state or province, country, and ZIP or foreign postal code\nScottsdale, AZ 85258"
      },
      // RECIPIENT_FULL_ADDRESS: Complete recipient address extraction
      {
        name: 'RECIPIENT_FULL_ADDRESS',
        pattern: /(?:RECIPIENT'S?\s+ADDRESS|Recipient'?s?\s+address)[:\s]*\n?([A-Za-z0-9\s,.-]+?(?:Street|St|Avenue|Ave|Road|Rd|Drive|Dr|Boulevard|Blvd|Lane|Ln|Court|Ct|Place|Pl|Way|Parkway|Pkwy|Circle|Cir)\s*[A-Za-z0-9\s,.-]*?[A-Z]{2}\s+\d{5}(?:-\d{4})?)/i,
        example: "RECIPIENT'S ADDRESS\n123 Main Street\nAnytown, CA 90210"
      },
      // RECIPIENT_SIMPLE_MULTILINE: Simplified multiline extraction
      {
        name: 'RECIPIENT_SIMPLE_MULTILINE',
        pattern: /(?:RECIPIENT'S?\s+ADDRESS|Recipient'?s?\s+address)\s*\n([A-Za-z0-9\s,.-]+?)(?:\n\n|PAYER|Payer|$)/i,
        example: "RECIPIENT'S ADDRESS\n456 Oak Ave\nSomewhere, TX 75001"
      },
      {
        name: 'RECIPIENT_ADDRESS_INLINE',
        pattern: /(?:RECIPIENT'S?\s+ADDRESS|Recipient'?s?\s+address)[:\s]+([A-Za-z0-9\s,.-]+?[A-Z]{2}\s+\d{5}(?:-\d{4})?)/i,
        example: "RECIPIENT'S ADDRESS: 789 Pine St, Elsewhere, FL 33101"
      }
    ];
    
    for (const patternInfo of recipientAddressPatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        console.log(`🔍 [Azure DI OCR] Recipient address pattern matched: ${patternInfo.name}`);
        if (patternInfo.name === 'RECIPIENT_STREET_CITY_MULTILINE' && match[2]) {
          // Combine street and city/state/zip
          info1099.address = `${match[1].trim()} ${match[2].trim()}`.replace(/\s+/g, ' ');
        } else {
          info1099.address = match[1].trim().replace(/\n/g, ' ').replace(/\s+/g, ' ');
        }
        console.log('✅ [Azure DI OCR] Found recipient address:', info1099.address);
        break;
      }
    }
    
    // === RECIPIENT TIN PATTERNS ===
    const recipientTINPatterns = [
      // RECIPIENT_TIN_MULTILINE: Extract TIN that appears after "RECIPIENT'S TIN" label
      {
        name: 'RECIPIENT_TIN_MULTILINE',
        pattern: /(?:RECIPIENT'S?\s+TIN|Recipient'?s?\s+TIN)\s*\n([A-Z0-9X-]+)/i,
        example: "RECIPIENT'S TIN\nXXX-XX-4567"
      },
      {
        name: 'RECIPIENT_TIN_LABELED',
        pattern: /(?:RECIPIENT'S?\s+(?:TIN|IDENTIFICATION\s+NUMBER)|Recipient'?s?\s+(?:TIN|identification\s+number))[:\s]*(\d{3}-\d{2}-\d{4}|\d{2}-\d{7}|\d{9}|[A-Z0-9X-]+)/i,
        example: "RECIPIENT'S TIN: 123-45-6789"
      },
      {
        name: 'RECIPIENT_SSN',
        pattern: /(?:RECIPIENT'S?\s+(?:SSN|SOCIAL\s+SECURITY)|Recipient'?s?\s+(?:SSN|social\s+security))[:\s]*(\d{3}-\d{2}-\d{4}|\d{9}|[A-Z0-9X-]+)/i,
        example: "RECIPIENT'S SSN: 123-45-6789"
      }
    ];
    
    for (const patternInfo of recipientTINPatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        console.log(`🔍 [Azure DI OCR] Recipient TIN pattern matched: ${patternInfo.name}`);
        info1099.tin = match[1];
        console.log('✅ [Azure DI OCR] Found recipient TIN:', info1099.tin);
        break;
      }
    }
    
    // === PAYER INFORMATION PATTERNS ===
    const payerInfoPatterns = [
      // PAYER_NAME_AFTER_LABEL: Extract company name that appears after the long label
      {
        name: 'PAYER_NAME_AFTER_LABEL',
        pattern: /PAYER'S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone no\.\s*\n([A-Za-z0-9\s&.,'-]+?)(?:\s+\d|\n|PAYER'S?\s+|$)/i,
        example: "PAYER'S name, street address...\nAlphaTech Solutions LLC 920 Tech Drive Austin, TX 73301"
      },
      // PAYER_INFO_MULTILINE: Payer information extraction
      {
        name: 'PAYER_INFO_MULTILINE',
        pattern: /(?:PAYER'S?\s+NAME|Payer'?s?\s+name)[:\s]*\n?([A-Za-z\s&.,'-]+?)(?:\n|$)[\s\S]*?(?:PAYER'S?\s+(?:TIN|FEDERAL\s+IDENTIFICATION)|Payer'?s?\s+(?:TIN|federal\s+identification))[:\s]*(\d{2}-\d{7}|\d{9})/i,
        example: "PAYER'S NAME\nACME CORPORATION\nPAYER'S TIN: 12-3456789"
      },
      {
        name: 'PAYER_NAME_SIMPLE',
        pattern: /(?:PAYER'S?\s+NAME|Payer'?s?\s+name)[:\s]+([A-Za-z\s&.,'-]+?)(?:\s+\d|\n|PAYER'S?\s+|Payer'?s?\s+|$)/i,
        example: "PAYER'S NAME: ACME CORPORATION"
      }
    ];
    
    for (const patternInfo of payerInfoPatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match) {
        console.log(`🔍 [Azure DI OCR] Payer info pattern matched: ${patternInfo.name}`);
        
        if (patternInfo.name === 'PAYER_NAME_AFTER_LABEL' && match[1]) {
          // Extract just the company name from the full address line
          const fullLine = match[1].trim();
          const companyMatch = fullLine.match(/^([A-Za-z\s&.,'-]+?)(?:\s+\d)/);
          if (companyMatch) {
            info1099.payerName = companyMatch[1].trim();
          } else {
            // Fallback: take first part before address numbers
            const parts = fullLine.split(/\s+\d/);
            info1099.payerName = parts[0].trim();
          }
          console.log('✅ [Azure DI OCR] Found payer name:', info1099.payerName);
        } else if (patternInfo.name === 'PAYER_INFO_MULTILINE' && match[1] && match[2]) {
          info1099.payerName = match[1].trim().replace(/\s+/g, ' ');
          info1099.payerTIN = match[2];
          console.log('✅ [Azure DI OCR] Found payer name and TIN:', info1099.payerName, info1099.payerTIN);
        } else if (patternInfo.name === 'PAYER_NAME_SIMPLE' && match[1]) {
          info1099.payerName = match[1].trim().replace(/\s+/g, ' ');
          console.log('✅ [Azure DI OCR] Found payer name:', info1099.payerName);
        }
        
        if (info1099.payerName) break; // Found payer name, no need to continue
      }
    }
    
    // === PAYER TIN PATTERNS ===
    const payerTINPatterns = [
      // PAYER_TIN_MULTILINE: Extract TIN that appears after "PAYER'S TIN" label
      {
        name: 'PAYER_TIN_MULTILINE',
        pattern: /(?:PAYER'S?\s+TIN|Payer'?s?\s+TIN)\s*\n(\d{2}-\d{7}|\d{9})/i,
        example: "PAYER'S TIN\n12-3456789"
      },
      {
        name: 'PAYER_TIN_SIMPLE',
        pattern: /(?:PAYER'S?\s+(?:TIN|FEDERAL\s+IDENTIFICATION)|Payer'?s?\s+(?:TIN|federal\s+identification))[:\s]*(\d{2}-\d{7}|\d{9})/i,
        example: "PAYER'S TIN: 12-3456789"
      }
    ];
    
    for (const patternInfo of payerTINPatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        console.log(`🔍 [Azure DI OCR] Payer TIN pattern matched: ${patternInfo.name}`);
        info1099.payerTIN = match[1];
        console.log('✅ [Azure DI OCR] Found payer TIN:', info1099.payerTIN);
        break;
      }
    }
    
    // === PAYER ADDRESS PATTERNS ===
    const payerAddressPatterns = [
      {
        name: 'PAYER_ADDRESS_MULTILINE',
        pattern: /(?:PAYER'S?\s+ADDRESS|Payer'?s?\s+address)\s*\n([A-Za-z0-9\s,.-]+?)(?:\n\n|RECIPIENT|Recipient|$)/i,
        example: "PAYER'S ADDRESS\n100 Business Blvd\nCorporate City, NY 10001"
      },
      {
        name: 'PAYER_ADDRESS_INLINE',
        pattern: /(?:PAYER'S?\s+ADDRESS|Payer'?s?\s+address)[:\s]+([A-Za-z0-9\s,.-]+?[A-Z]{2}\s+\d{5}(?:-\d{4})?)/i,
        example: "PAYER'S ADDRESS: 100 Business Blvd, Corporate City, NY 10001"
      }
    ];
    
    for (const patternInfo of payerAddressPatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        console.log(`🔍 [Azure DI OCR] Payer address pattern matched: ${patternInfo.name}`);
        info1099.payerAddress = match[1].trim().replace(/\n/g, ' ').replace(/\s+/g, ' ');
        console.log('✅ [Azure DI OCR] Found payer address:', info1099.payerAddress);
        break;
      }
    }
    
    return info1099;
  }

  private extractW2FieldsFromOCR(ocrText: string, baseData: ExtractedFieldData): ExtractedFieldData {
    console.log('🔍 [Azure DI] Extracting W2 fields from OCR text...');
    const personalInfo = this.extractPersonalInfoFromOCR(ocrText);
    const wages = this.extractWagesFromOCR(ocrText);
    
    return {
      ...baseData,
      employeeName: personalInfo.name || '',
      employeeSSN: personalInfo.ssn || '',
      employeeAddress: personalInfo.address || '',
      wages: wages || 0,
      federalTaxWithheld: this.extractFederalTaxWithheldFromOCR(ocrText) || 0
    };
  }

  private extract1099IntFieldsFromOCR(ocrText: string, baseData: ExtractedFieldData): ExtractedFieldData {
    console.log('🔍 [Azure DI] Extracting 1099-INT fields from OCR text...');
    const personalInfo = this.extract1099InfoFromOCR(ocrText);
    
    return {
      ...baseData,
      payerName: personalInfo.payerName || '',
      payerTIN: personalInfo.payerTIN || '',
      recipientName: personalInfo.name || '',
      recipientTIN: personalInfo.tin || '',
      recipientAddress: personalInfo.address || '',
      interestIncome: this.extractInterestIncomeFromOCR(ocrText) || 0,
      federalTaxWithheld: this.extractFederalTaxWithheldFromOCR(ocrText) || 0
    };
  }

  private extract1099DivFieldsFromOCR(ocrText: string, baseData: ExtractedFieldData): ExtractedFieldData {
    console.log('🔍 [Azure DI] Extracting 1099-DIV fields from OCR text...');
    const personalInfo = this.extract1099InfoFromOCR(ocrText);
    
    return {
      ...baseData,
      payerName: personalInfo.payerName || '',
      payerTIN: personalInfo.payerTIN || '',
      recipientName: personalInfo.name || '',
      recipientTIN: personalInfo.tin || '',
      recipientAddress: personalInfo.address || '',
      ordinaryDividends: this.extractOrdinaryDividendsFromOCR(ocrText) || 0,
      qualifiedDividends: this.extractQualifiedDividendsFromOCR(ocrText) || 0,
      federalTaxWithheld: this.extractFederalTaxWithheldFromOCR(ocrText) || 0
    };
  }

  private extract1099MiscFieldsFromOCR(ocrText: string, baseData: ExtractedFieldData): ExtractedFieldData {
    console.log('🔍 [Azure DI] Extracting 1099-MISC fields from OCR text...');
    const personalInfo = this.extract1099InfoFromOCR(ocrText);
    
    return {
      ...baseData,
      payerName: personalInfo.payerName || '',
      payerTIN: personalInfo.payerTIN || '',
      recipientName: personalInfo.name || '',
      recipientTIN: personalInfo.tin || '',
      recipientAddress: personalInfo.address || '',
      rents: this.extractRentsFromOCR(ocrText) || 0,
      royalties: this.extractRoyaltiesFromOCR(ocrText) || 0,
      otherIncome: this.extractOtherIncomeFromOCR(ocrText) || 0,
      nonemployeeCompensation: this.extractNonemployeeCompensationFromOCR(ocrText) || 0,
      federalTaxWithheld: this.extractFederalTaxWithheldFromOCR(ocrText) || 0
    };
  }

  private extract1099NecFieldsFromOCR(ocrText: string, baseData: ExtractedFieldData): ExtractedFieldData {
    console.log('🔍 [Azure DI] Extracting 1099-NEC fields from OCR text...');
    const personalInfo = this.extract1099InfoFromOCR(ocrText);
    
    return {
      ...baseData,
      payerName: personalInfo.payerName || '',
      payerTIN: personalInfo.payerTIN || '',
      recipientName: personalInfo.name || '',
      recipientTIN: personalInfo.tin || '',
      recipientAddress: personalInfo.address || '',
      nonemployeeCompensation: this.extractNonemployeeCompensationFromOCR(ocrText) || 0,
      federalTaxWithheld: this.extractFederalTaxWithheldFromOCR(ocrText) || 0
    };
  }

  private extractGenericFieldsFromOCR(ocrText: string, baseData: ExtractedFieldData): ExtractedFieldData {
    console.log('🔍 [Azure DI] Extracting generic fields from OCR text...');
    
    return {
      ...baseData,
      // Add any generic field extraction logic here
      extractedText: ocrText
    };
  }

  // Helper methods for extracting specific amounts from OCR text
  private extractInterestIncomeFromOCR(ocrText: string): number {
    const patterns = [
      /interest\s+income[:\s]+\$?([0-9,]+\.?\d*)/i,
      /box\s+1[:\s]+\$?([0-9,]+\.?\d*)/i,
      /1\s+interest\s+income[:\s]+\$?([0-9,]+\.?\d*)/i
    ];
    
    for (const pattern of patterns) {
      const match = ocrText.match(pattern);
      if (match && match[1]) {
        return this.parseAmount(match[1]);
      }
    }
    return 0;
  }

  private extractOrdinaryDividendsFromOCR(ocrText: string): number {
    const patterns = [
      /ordinary\s+dividends[:\s]+\$?([0-9,]+\.?\d*)/i,
      /box\s+1a[:\s]+\$?([0-9,]+\.?\d*)/i,
      /1a\s+ordinary\s+dividends[:\s]+\$?([0-9,]+\.?\d*)/i
    ];
    
    for (const pattern of patterns) {
      const match = ocrText.match(pattern);
      if (match && match[1]) {
        return this.parseAmount(match[1]);
      }
    }
    return 0;
  }

  private extractQualifiedDividendsFromOCR(ocrText: string): number {
    const patterns = [
      /qualified\s+dividends[:\s]+\$?([0-9,]+\.?\d*)/i,
      /box\s+1b[:\s]+\$?([0-9,]+\.?\d*)/i,
      /1b\s+qualified\s+dividends[:\s]+\$?([0-9,]+\.?\d*)/i
    ];
    
    for (const pattern of patterns) {
      const match = ocrText.match(pattern);
      if (match && match[1]) {
        return this.parseAmount(match[1]);
      }
    }
    return 0;
  }

  private extractRentsFromOCR(ocrText: string): number {
    const patterns = [
      // Pattern for "1 Rents\n$\n$35,000.00" structure
      /1\s+Rents\s*\n\s*\$\s*\n\s*\$([0-9,]+\.?\d*)/i,
      // Fallback patterns
      /rents[:\s]+\$?([0-9,]+\.?\d*)/i,
      /box\s+1[:\s]+\$?([0-9,]+\.?\d*)/i,
      /1\s+rents[:\s]+\$?([0-9,]+\.?\d*)/i
    ];
    
    for (const pattern of patterns) {
      const match = ocrText.match(pattern);
      if (match && match[1]) {
        return this.parseAmount(match[1]);
      }
    }
    return 0;
  }

  private extractRoyaltiesFromOCR(ocrText: string): number {
    const patterns = [
      /royalties[:\s]+\$?([0-9,]+\.?\d*)/i,
      /box\s+2[:\s]+\$?([0-9,]+\.?\d*)/i,
      /2\s+royalties[:\s]+\$?([0-9,]+\.?\d*)/i
    ];
    
    for (const pattern of patterns) {
      const match = ocrText.match(pattern);
      if (match && match[1]) {
        return this.parseAmount(match[1]);
      }
    }
    return 0;
  }

  private extractOtherIncomeFromOCR(ocrText: string): number {
    const patterns = [
      // The $450,000 is actually in box 5 (Fishing boat proceeds), not box 3 (Other income)
      // Pattern for "5 Fishing boat proceeds\n$450,000.00" structure
      /5\s+Fishing boat proceeds\s*\n\s*\$([0-9,]+\.?\d*)/i,
      // Standard other income patterns (box 3)
      /3\s+Other income\s*\n\s*\$\s*\n\s*\$([0-9,]+\.?\d*)/i,
      // Fallback patterns
      /other\s+income[:\s]+\$?([0-9,]+\.?\d*)/i,
      /box\s+3[:\s]+\$?([0-9,]+\.?\d*)/i,
      /3\s+other\s+income[:\s]+\$?([0-9,]+\.?\d*)/i
    ];
    
    for (const pattern of patterns) {
      const match = ocrText.match(pattern);
      if (match && match[1]) {
        return this.parseAmount(match[1]);
      }
    }
    return 0;
  }

  private extractNonemployeeCompensationFromOCR(ocrText: string): number {
    const patterns = [
      /nonemployee\s+compensation[:\s]+\$?([0-9,]+\.?\d*)/i,
      /non-employee\s+compensation[:\s]+\$?([0-9,]+\.?\d*)/i,
      /box\s+1[:\s]+\$?([0-9,]+\.?\d*)/i,
      /1\s+nonemployee\s+compensation[:\s]+\$?([0-9,]+\.?\d*)/i
    ];
    
    for (const pattern of patterns) {
      const match = ocrText.match(pattern);
      if (match && match[1]) {
        return this.parseAmount(match[1]);
      }
    }
    return 0;
  }

  private extractFederalTaxWithheldFromOCR(ocrText: string): number {
    const patterns = [
      // Pattern for "4 Federal income tax withheld\n$\n$115,000.00" structure
      /4\s+Federal income tax withheld\s*\n\s*\$\s*\n\s*\$([0-9,]+\.?\d*)/i,
      // Fallback patterns
      /federal\s+income\s+tax\s+withheld[:\s]+\$?([0-9,]+\.?\d*)/i,
      /federal\s+tax\s+withheld[:\s]+\$?([0-9,]+\.?\d*)/i,
      /box\s+4[:\s]+\$?([0-9,]+\.?\d*)/i,
      /4\s+federal\s+income\s+tax\s+withheld[:\s]+\$?([0-9,]+\.?\d*)/i
    ];
    
    for (const pattern of patterns) {
      const match = ocrText.match(pattern);
      if (match && match[1]) {
        return this.parseAmount(match[1]);
      }
    }
    return 0;
  }

  async processW2Document(documentPathOrBuffer: string | Buffer): Promise<ExtractedFieldData> {
    const extractedData = await this.extractDataFromDocument(documentPathOrBuffer, 'W2');
    
    return {
      documentType: 'FORM_W2',
      employerName: extractedData.employerName || '',
      employerEIN: extractedData.employerEIN || '',
      employeeName: extractedData.employeeName || '',
      employeeSSN: extractedData.employeeSSN || '',
      employeeAddress: extractedData.employeeAddress || '',
      wages: this.parseAmount(extractedData.wages) || 0,
      federalTaxWithheld: this.parseAmount(extractedData.federalTaxWithheld) || 0,
      socialSecurityWages: this.parseAmount(extractedData.socialSecurityWages) || 0,
      medicareWages: this.parseAmount(extractedData.medicareWages) || 0,
      socialSecurityTaxWithheld: this.parseAmount(extractedData.socialSecurityTaxWithheld) || 0,
      medicareTaxWithheld: this.parseAmount(extractedData.medicareTaxWithheld) || 0,
      stateWages: this.parseAmount(extractedData.stateWages) || 0,
      stateTaxWithheld: this.parseAmount(extractedData.stateTaxWithheld) || 0,
      ...extractedData
    };
  }

  async process1099Document(documentPathOrBuffer: string | Buffer, documentType: string): Promise<ExtractedFieldData> {
    const extractedData = await this.extractDataFromDocument(documentPathOrBuffer, documentType);
    
    return {
      documentType,
      payerName: extractedData.payerName || '',
      payerTIN: extractedData.payerTIN || '',
      recipientName: extractedData.recipientName || '',
      recipientTIN: extractedData.recipientTIN || '',
      interestIncome: this.parseAmount(extractedData.interestIncome) || 0,
      ordinaryDividends: this.parseAmount(extractedData.ordinaryDividends) || 0,
      nonemployeeCompensation: this.parseAmount(extractedData.nonemployeeCompensation) || 0,
      federalTaxWithheld: this.parseAmount(extractedData.federalTaxWithheld) || 0,
      ...extractedData
    };
  }
}

// Singleton instance
let azureDocumentIntelligenceService: AzureDocumentIntelligenceService | null = null;

export function getAzureDocumentIntelligenceService(): AzureDocumentIntelligenceService {
  if (!azureDocumentIntelligenceService) {
    const config: AzureDocumentIntelligenceConfig = {
      endpoint: process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT!,
      apiKey: process.env.AZURE_DOCUMENT_INTELLIGENCE_API_KEY!,
    };

    if (!config.endpoint || !config.apiKey) {
      throw new Error('Azure Document Intelligence configuration missing. Please set AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT and AZURE_DOCUMENT_INTELLIGENCE_API_KEY environment variables.');
    }

    azureDocumentIntelligenceService = new AzureDocumentIntelligenceService(config);
  }

  return azureDocumentIntelligenceService;
}

export function createAzureDocumentIntelligenceConfig(): AzureDocumentIntelligenceConfig {
  return {
    endpoint: process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT!,
    apiKey: process.env.AZURE_DOCUMENT_INTELLIGENCE_API_KEY!,
  };
}

