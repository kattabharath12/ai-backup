


import { DocumentAnalysisClient, AzureKeyCredential } from "@azure/ai-form-recognizer";
import { DocumentType } from "@prisma/client";
import { readFile } from "fs/promises";

export interface AzureDocumentIntelligenceConfig {
  endpoint: string;
  apiKey: string;
}

export interface ExtractedFieldData {
  [key: string]: string | number | DocumentType | number[] | undefined;
  correctedDocumentType?: DocumentType;
  fullText?: string;
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
      console.log('🔍 [Azure DI] Initial document type:', documentType);
      
      // Get document buffer - either from file path or use provided buffer
      const documentBuffer = typeof documentPathOrBuffer === 'string' 
        ? await readFile(documentPathOrBuffer)
        : documentPathOrBuffer;
      
      // Determine the model to use based on document type
      const modelId = this.getModelIdForDocumentType(documentType);
      console.log('🔍 [Azure DI] Using model:', modelId);
      
      let extractedData: ExtractedFieldData;
      let correctedDocumentType: DocumentType | undefined;
      
      try {
        // Analyze the document with specific tax model
        const poller = await this.client.beginAnalyzeDocument(modelId, documentBuffer);
        const result = await poller.pollUntilDone();
        
        console.log('✅ [Azure DI] Document analysis completed with tax model');
        
        // Extract the data based on document type
        extractedData = this.extractTaxDocumentFields(result, documentType);
        
        // Perform OCR-based document type correction if we have OCR text
        if (extractedData.fullText) {
          const ocrBasedType = this.analyzeDocumentTypeFromOCR(extractedData.fullText as string);
          if (ocrBasedType !== 'UNKNOWN' && ocrBasedType !== documentType) {
            console.log(`🔄 [Azure DI] Document type correction: ${documentType} → ${ocrBasedType}`);
            
            // Convert string to DocumentType enum with validation
            if (Object.values(DocumentType).includes(ocrBasedType as DocumentType)) {
              correctedDocumentType = ocrBasedType as DocumentType;
              
              // Re-extract data with the corrected document type
              console.log('🔍 [Azure DI] Re-extracting data with corrected document type...');
              extractedData = this.extractTaxDocumentFields(result, ocrBasedType);
            } else {
              console.log(`⚠️ [Azure DI] Invalid document type detected: ${ocrBasedType}, ignoring correction`);
            }
          }
        }
        
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
          extractedData = this.extractTaxDocumentFieldsFromOCR(fallbackResult, documentType);
          
          // Perform OCR-based document type correction
          if (extractedData.fullText) {
            const ocrBasedType = this.analyzeDocumentTypeFromOCR(extractedData.fullText as string);
            if (ocrBasedType !== 'UNKNOWN' && ocrBasedType !== documentType) {
              console.log(`🔄 [Azure DI] Document type correction (OCR fallback): ${documentType} → ${ocrBasedType}`);
              
              // Convert string to DocumentType enum with validation
              if (Object.values(DocumentType).includes(ocrBasedType as DocumentType)) {
                correctedDocumentType = ocrBasedType as DocumentType;
                
                // Re-extract data with the corrected document type
                console.log('🔍 [Azure DI] Re-extracting data with corrected document type...');
                extractedData = this.extractTaxDocumentFieldsFromOCR(fallbackResult, ocrBasedType);
              } else {
                console.log(`⚠️ [Azure DI] Invalid document type detected: ${ocrBasedType}, ignoring correction`);
              }
            }
          }
        } else {
          // Re-throw if it's not a model availability issue
          throw modelError;
        }
      }
      
      // Add the corrected document type to the result if it was changed
      if (correctedDocumentType) {
        extractedData.correctedDocumentType = correctedDocumentType;
      }
      
      return extractedData;
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
    
    // Comprehensive field mappings for all 1099-MISC boxes
    const fieldMappings = {
      // Payer and recipient information
      'Payer.Name': 'payerName',
      'Payer.TIN': 'payerTIN',
      'Payer.Address': 'payerAddress',
      'Recipient.Name': 'recipientName',
      'Recipient.TIN': 'recipientTIN',
      'Recipient.Address': 'recipientAddress',
      'AccountNumber': 'accountNumber',
      
      // Box 1-18 mappings
      'Rents': 'rents',                                           // Box 1
      'Royalties': 'royalties',                                   // Box 2
      'OtherIncome': 'otherIncome',                              // Box 3
      'FederalIncomeTaxWithheld': 'federalTaxWithheld',          // Box 4
      'FishingBoatProceeds': 'fishingBoatProceeds',              // Box 5
      'MedicalAndHealthCarePayments': 'medicalHealthPayments',    // Box 6
      'NonemployeeCompensation': 'nonemployeeCompensation',       // Box 7 (deprecated)
      'SubstitutePayments': 'substitutePayments',                 // Box 8
      'CropInsuranceProceeds': 'cropInsuranceProceeds',          // Box 9
      'GrossProceedsPaidToAttorney': 'attorneyProceeds',         // Box 10
      'FishPurchasedForResale': 'fishPurchases',                 // Box 11
      'Section409ADeferrals': 'section409ADeferrals',            // Box 12
      'ExcessGoldenParachutePayments': 'excessGoldenParachutePayments', // Box 13
      'NonqualifiedDeferredCompensation': 'nonqualifiedDeferredCompensation', // Box 14
      'Section409AIncome': 'section409AIncome',                  // Box 15a
      'StateTaxWithheld': 'stateTaxWithheld',                    // Box 16
      'StatePayerNumber': 'statePayerNumber',                    // Box 17
      'StateIncome': 'stateIncome',                              // Box 18
      
      // Alternative field names that Azure might use
      'Box1': 'rents',
      'Box2': 'royalties',
      'Box3': 'otherIncome',
      'Box4': 'federalTaxWithheld',
      'Box5': 'fishingBoatProceeds',
      'Box6': 'medicalHealthPayments',
      'Box7': 'nonemployeeCompensation',
      'Box8': 'substitutePayments',
      'Box9': 'cropInsuranceProceeds',
      'Box10': 'attorneyProceeds',
      'Box11': 'fishPurchases',
      'Box12': 'section409ADeferrals',
      'Box13': 'excessGoldenParachutePayments',
      'Box14': 'nonqualifiedDeferredCompensation',
      'Box15a': 'section409AIncome',
      'Box16': 'stateTaxWithheld',
      'Box17': 'statePayerNumber',
      'Box18': 'stateIncome'
    };
    
    for (const [azureFieldName, mappedFieldName] of Object.entries(fieldMappings)) {
      if (fields[azureFieldName]?.value !== undefined) {
        const value = fields[azureFieldName].value;
        
        // Handle text fields vs numeric fields
        if (mappedFieldName === 'statePayerNumber' || mappedFieldName === 'accountNumber') {
          data[mappedFieldName] = String(value).trim();
        } else {
          data[mappedFieldName] = typeof value === 'number' ? value : this.parseAmount(value);
        }
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
      
      if (!data.payerAddress && personalInfoFromOCR.payerAddress) {
        data.payerAddress = personalInfoFromOCR.payerAddress;
        console.log('✅ [Azure DI] Extracted payer address from OCR:', data.payerAddress);
      }
    }
    
    // OCR fallback for missing box amounts
    if (baseData.fullText) {
      const missingFields = [];
      const expectedFields = ['rents', 'royalties', 'otherIncome', 'federalTaxWithheld', 'fishingBoatProceeds', 
                             'medicalHealthPayments', 'substitutePayments', 'cropInsuranceProceeds', 'attorneyProceeds',
                             'fishPurchases', 'section409ADeferrals', 'excessGoldenParachutePayments', 
                             'nonqualifiedDeferredCompensation', 'section409AIncome', 'stateTaxWithheld', 'stateIncome'];
      
      for (const field of expectedFields) {
        if (!data[field] || data[field] === 0) {
          missingFields.push(field);
        }
      }
      
      if (missingFields.length > 0) {
        console.log(`🔍 [Azure DI] Missing ${missingFields.length} fields from structured extraction, attempting OCR fallback...`);
        const ocrData = this.extract1099MiscFieldsFromOCR(baseData.fullText as string, {});
        
        for (const field of missingFields) {
          if (ocrData[field] && ocrData[field] !== 0) {
            data[field] = ocrData[field];
            console.log(`✅ [Azure DI] Recovered ${field} from OCR: ${ocrData[field]}`);
          }
        }
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
    
    // Process all available fields
    for (const [fieldName, fieldData] of Object.entries(fields)) {
      if (fieldData && typeof fieldData === 'object' && 'value' in fieldData) {
        const value = (fieldData as any).value;
        if (value !== undefined && value !== null && value !== '') {
          data[fieldName] = typeof value === 'number' ? value : this.parseAmount(value);
        }
      }
    }
    
    return data;
  }

  public analyzeDocumentTypeFromOCR(ocrText: string): string {
    console.log('🔍 [Azure DI] Analyzing document type from OCR content...');
    
    const formType = this.detectFormType(ocrText);
    
    if (formType === 'W2') {
      console.log('✅ [Azure DI] Confirmed W2 document type');
      return 'W2';
    } else if (formType === '1099') {
      const specific1099Type = this.detectSpecific1099Type(ocrText);
      console.log(`✅ [Azure DI] Detected specific 1099 type: ${specific1099Type}`);
      return specific1099Type;
    }
    
    console.log('⚠️ [Azure DI] Could not determine document type from OCR');
    return 'UNKNOWN';
  }

  public detectSpecific1099Type(ocrText: string): string {
    console.log('🔍 [Azure DI] Detecting specific 1099 subtype from OCR text...');
    
    const text = ocrText.toLowerCase();
    
    // Check for specific 1099 form types with high-confidence indicators
    const formTypePatterns = [
      {
        type: 'FORM_1099_DIV',
        indicators: [
          'form 1099-div',
          'dividends and distributions',
          'ordinary dividends',
          'qualified dividends',
          'total capital gain distributions',
          'capital gain distributions'
        ]
      },
      {
        type: 'FORM_1099_INT',
        indicators: [
          'form 1099-int',
          'interest income',
          'early withdrawal penalty',
          'interest on u.s. treasury obligations',
          'investment expenses'
        ]
      },
      {
        type: 'FORM_1099_MISC',
        indicators: [
          'form 1099-misc',
          'miscellaneous income',
          'nonemployee compensation',
          'rents',
          'royalties',
          'fishing boat proceeds'
        ]
      },
      {
        type: 'FORM_1099_NEC',
        indicators: [
          'form 1099-nec',
          'nonemployee compensation',
          'nec'
        ]
      }
    ];
    
    // Score each form type based on indicator matches
    let bestMatch = { type: 'FORM_1099_MISC', score: 0 }; // Default to MISC
    
    for (const formPattern of formTypePatterns) {
      let score = 0;
      for (const indicator of formPattern.indicators) {
        if (text.includes(indicator)) {
          score += 1;
          console.log(`✅ [Azure DI] Found indicator "${indicator}" for ${formPattern.type}`);
        }
      }
      
      if (score > bestMatch.score) {
        bestMatch = { type: formPattern.type, score };
      }
    }
    
    console.log(`✅ [Azure DI] Best match: ${bestMatch.type} (score: ${bestMatch.score})`);
    return bestMatch.type;
  }

  private detectFormType(ocrText: string): string {
    const text = ocrText.toLowerCase();
    
    // W2 indicators
    const w2Indicators = [
      'form w-2',
      'wage and tax statement',
      'wages, tips, other compensation',
      'federal income tax withheld',
      'social security wages',
      'medicare wages'
    ];
    
    // 1099 indicators
    const form1099Indicators = [
      'form 1099',
      '1099-',
      'payer',
      'recipient',
      'tin'
    ];
    
    // Count matches for each form type
    let w2Score = 0;
    let form1099Score = 0;
    
    for (const indicator of w2Indicators) {
      if (text.includes(indicator)) {
        w2Score++;
      }
    }
    
    for (const indicator of form1099Indicators) {
      if (text.includes(indicator)) {
        form1099Score++;
      }
    }
    
    console.log(`🔍 [Azure DI] Form type scores - W2: ${w2Score}, 1099: ${form1099Score}`);
    
    if (w2Score > form1099Score) {
      return 'W2';
    } else if (form1099Score > 0) {
      return '1099';
    }
    
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
        name: 'RECIPIENT_NAME_COLON',
        pattern: /(?:RECIPIENT'S?\s+name|Recipient'?s?\s+name):\s*([A-Za-z\s]+?)(?:\n|RECIPIENT'S?\s+|Recipient'?s?\s+|TIN|address|street|$)/i,
        example: "RECIPIENT'S name: JOHN DOE"
      }
    ];
    
    // Try recipient name patterns
    for (const patternInfo of recipientNamePatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        const name = match[1].trim();
        if (name.length > 2 && /^[A-Za-z\s]+$/.test(name)) {
          info1099.name = name;
          console.log(`✅ [Azure DI OCR] Found recipient name using ${patternInfo.name}:`, name);
          break;
        }
      }
    }
    
    // === RECIPIENT TIN PATTERNS ===
    const recipientTinPatterns = [
      {
        name: 'RECIPIENT_TIN_BASIC',
        pattern: /(?:RECIPIENT'S?\s+TIN|Recipient'?s?\s+TIN)[:\s]+(\d{2,3}[-\s]?\d{2}[-\s]?\d{4})/i,
        example: "RECIPIENT'S TIN 123-45-6789"
      },
      {
        name: 'RECIPIENT_TIN_MULTILINE',
        pattern: /(?:RECIPIENT'S?\s+TIN|Recipient'?s?\s+TIN)\s*\n(\d{2,3}[-\s]?\d{2}[-\s]?\d{4})/i,
        example: "RECIPIENT'S TIN\n123-45-6789"
      }
    ];
    
    // Try recipient TIN patterns
    for (const patternInfo of recipientTinPatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        const tin = match[1].trim();
        if (tin.length >= 9) {
          info1099.tin = tin;
          console.log(`✅ [Azure DI OCR] Found recipient TIN using ${patternInfo.name}:`, tin);
          break;
        }
      }
    }
    
    // === RECIPIENT ADDRESS PATTERNS ===
    const recipientAddressPatterns = [
      {
        name: 'RECIPIENT_ADDRESS_MULTILINE',
        pattern: /(?:RECIPIENT'S?\s+address|Recipient'?s?\s+address)\s*\n([^\n]+(?:\n[^\n]+)*?)(?:\n\s*\n|PAYER'S?\s+|Payer'?s?\s+|$)/i,
        example: "RECIPIENT'S address\n123 Main St\nAnytown, ST 12345"
      },
      {
        name: 'RECIPIENT_ADDRESS_BASIC',
        pattern: /(?:RECIPIENT'S?\s+address|Recipient'?s?\s+address)[:\s]+([^\n]+(?:\n[^\n]+)*?)(?:\n\s*\n|PAYER'S?\s+|Payer'?s?\s+|$)/i,
        example: "RECIPIENT'S address: 123 Main St, Anytown, ST 12345"
      },
      {
        name: 'RECIPIENT_ADDRESS_STREET_CITY',
        pattern: /Street\s+address[^\n]*\n([^\n]+)\n[^\n]*City[^\n]*\n([^\n]+)/i,
        example: "Street address (including apt. no.)\n456 MAIN STREET\nCity or town, state or province, country, and ZIP or foreign postal code\nHOMETOWN, ST 67890"
      },
      {
        name: 'RECIPIENT_ADDRESS_COMBINED',
        pattern: /Street\s+address[^\n]*\n([^\n]+)\n[^\n]*\n([^\n]+)/i,
        example: "Street address\n456 MAIN STREET\nHOMETOWN, ST 67890"
      },
      {
        name: 'RECIPIENT_ADDRESS_AFTER_NAME',
        pattern: /RECIPIENT'S name\s*\n[^\n]+\s*\n(?:Street address[^\n]*\n)?([^\n]+)\s*\n(?:City[^\n]*\n)?([^\n]+)/i,
        example: "RECIPIENT'S name\nJordan Blake\nStreet address (including apt. no.)\n456 MAIN STREET\nCity or town, state or province, country, and ZIP or foreign postal code\nHOMETOWN, ST 67890"
      }
    ];
    
    // Try recipient address patterns
    for (const patternInfo of recipientAddressPatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        let address = '';
        
        // Handle patterns that capture street and city separately
        if (patternInfo.name === 'RECIPIENT_ADDRESS_STREET_CITY' || 
            patternInfo.name === 'RECIPIENT_ADDRESS_COMBINED' ||
            patternInfo.name === 'RECIPIENT_ADDRESS_AFTER_NAME') {
          if (match[2]) {
            // For AFTER_NAME pattern, properly combine street and city
            if (patternInfo.name === 'RECIPIENT_ADDRESS_AFTER_NAME') {
              // match[1] is the street address, match[2] is the city/state/zip
              // Skip if match[1] contains form labels
              if (match[1] && !match[1].toLowerCase().includes('street address') && 
                  !match[1].toLowerCase().includes('including apt')) {
                if (match[2] && !match[2].toLowerCase().includes('city or town')) {
                  address = `${match[1].trim()} ${match[2].trim()}`;
                } else {
                  address = match[1].trim();
                }
              } else if (match[2] && !match[2].toLowerCase().includes('city or town')) {
                // If match[1] is a label, use match[2] as the street and look for city separately
                const cityMatch = ocrText.match(/(?:City[^\n]*\n|^)([A-Z][A-Z\s,]+[A-Z]{2}\s+\d{5})/i);
                if (cityMatch) {
                  address = `${match[2].trim()} ${cityMatch[1].trim()}`;
                } else {
                  address = match[2].trim();
                }
              }
            } else {
              // Combine street address and city/state/zip
              address = `${match[1].trim()} ${match[2].trim()}`;
            }
          } else {
            address = match[1].trim();
          }
        } else {
          address = match[1].trim().replace(/\n+/g, ' ');
        }
        
        if (address.length > 5) {
          info1099.address = address;
          console.log(`✅ [Azure DI OCR] Found recipient address using ${patternInfo.name}:`, address);
          break;
        }
      }
    }
    
    // === PAYER NAME PATTERNS ===
    const payerNamePatterns = [
      {
        name: 'PAYER_NAME_MULTILINE',
        pattern: /(?:PAYER'S?\s+name|Payer'?s?\s+name)\s*\n([A-Za-z\s&.,'-]+?)(?:\n|$)/i,
        example: "PAYER'S name\nAcme Corporation"
      },
      {
        name: 'PAYER_NAME_BASIC',
        pattern: /(?:PAYER'S?\s+name|Payer'?s?\s+name)[:\s]+([A-Za-z\s&.,'-]+?)(?:\s+\d|\n|PAYER'S?\s+|Payer'?s?\s+|TIN|address|street|$)/i,
        example: "PAYER'S NAME ACME CORPORATION"
      }
    ];
    
    // Try payer name patterns
    for (const patternInfo of payerNamePatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        const name = match[1].trim();
        if (name.length > 2) {
          info1099.payerName = name;
          console.log(`✅ [Azure DI OCR] Found payer name using ${patternInfo.name}:`, name);
          break;
        }
      }
    }
    
    // === PAYER TIN PATTERNS ===
    const payerTinPatterns = [
      {
        name: 'PAYER_TIN_BASIC',
        pattern: /(?:PAYER'S?\s+TIN|Payer'?s?\s+TIN)[:\s]+(\d{2}[-\s]?\d{7})/i,
        example: "PAYER'S TIN 12-3456789"
      },
      {
        name: 'PAYER_TIN_MULTILINE',
        pattern: /(?:PAYER'S?\s+TIN|Payer'?s?\s+TIN)\s*\n(\d{2}[-\s]?\d{7})/i,
        example: "PAYER'S TIN\n12-3456789"
      }
    ];
    
    // Try payer TIN patterns
    for (const patternInfo of payerTinPatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        const tin = match[1].trim();
        if (tin.length >= 9) {
          info1099.payerTIN = tin;
          console.log(`✅ [Azure DI OCR] Found payer TIN using ${patternInfo.name}:`, tin);
          break;
        }
      }
    }
    
    // === PAYER ADDRESS PATTERNS ===
    const payerAddressPatterns = [
      {
        name: 'PAYER_ADDRESS_MULTILINE',
        pattern: /(?:PAYER'S?\s+name,\s+street\s+address,\s+city[^\n]*\n)([^\n]+(?:\n[^\n]+)*?)(?:\n\s*PAYER'S?\s+TIN|PAYER'S?\s+TIN|$)/i,
        example: "PAYER'S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone no.\nABC COMPANY INC\n123 BUSINESS ST\nANYTOWN, ST 12345"
      },
      {
        name: 'PAYER_ADDRESS_AFTER_NAME',
        pattern: /(?:PAYER'S?\s+name|Payer'?s?\s+name)\s*\n[^\n]+\n([^\n]+(?:\n[^\n]+)*?)(?:\n\s*PAYER'S?\s+TIN|PAYER'S?\s+TIN|RECIPIENT|$)/i,
        example: "PAYER'S name\nABC COMPANY INC\n123 BUSINESS ST\nANYTOWN, ST 12345"
      },
      {
        name: 'PAYER_ADDRESS_BASIC',
        pattern: /(?:PAYER'S?\s+address|Payer'?s?\s+address)[:\s]+([^\n]+(?:\n[^\n]+)*?)(?:\n\s*\n|RECIPIENT|$)/i,
        example: "PAYER'S address: 123 Business St, Anytown, ST 12345"
      }
    ];
    
    // Try payer address patterns
    for (const patternInfo of payerAddressPatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        let address = match[1].trim().replace(/\n+/g, ' ').replace(/\([^)]*\)/g, '').trim();
        // Remove phone numbers from address
        address = address.replace(/\s+\(\d{3}\)\s*\d{3}-\d{4}.*$/, '').replace(/\s+\d{3}-\d{3}-\d{4}.*$/, '').trim();
        // Remove form labels and instructions
        address = address.replace(/^.*?street\s+address[^,\n]*[,\n]\s*/i, '').replace(/^.*?telephone\s+no\.\s*/i, '').trim();
        // Clean up multiple spaces and ensure proper formatting
        address = address.replace(/\s+/g, ' ').trim();
        if (address.length > 5 && !address.toLowerCase().includes('payer') && !address.toLowerCase().includes('street address')) {
          info1099.payerAddress = address;
          console.log(`✅ [Azure DI OCR] Found payer address using ${patternInfo.name}:`, address);
          break;
        }
      }
    }
    
    return info1099;
  }

  // === W2 PATTERNS ===
  /**
   * Extracts personal information from W2 OCR text using comprehensive regex patterns
   * Specifically designed for W2 form OCR text patterns with enhanced fallback mechanisms
   */
  private extractPersonalInfoFromOCR(ocrText: string): {
    name?: string;
    ssn?: string;
    tin?: string;
    address?: string;
    employerName?: string;
    employerAddress?: string;
    payerName?: string;
    payerTIN?: string;
    payerAddress?: string;
  } {
    console.log('🔍 [Azure DI OCR] Searching for personal info in OCR text...');
    
    const personalInfo: { 
      name?: string; 
      ssn?: string; 
      tin?: string;
      address?: string;
      employerName?: string;
      employerAddress?: string;
      payerName?: string;
      payerTIN?: string;
      payerAddress?: string;
    } = {};
    
    // Check if this is a 1099 form first
    const is1099Form = /form\s+1099|1099-/i.test(ocrText);
    
    if (is1099Form) {
      console.log('🔍 [Azure DI OCR] Detected 1099 form, using 1099-specific patterns...');
      const info1099 = this.extract1099InfoFromOCR(ocrText);
      
      // Map 1099 fields to personal info structure
      if (info1099.name) personalInfo.name = info1099.name;
      if (info1099.tin) personalInfo.tin = info1099.tin;
      if (info1099.address) personalInfo.address = info1099.address;
      if (info1099.payerName) personalInfo.payerName = info1099.payerName;
      if (info1099.payerTIN) personalInfo.payerTIN = info1099.payerTIN;
      if (info1099.payerAddress) personalInfo.payerAddress = info1099.payerAddress;
      
      return personalInfo;
    }
    
    // W2-specific patterns
    console.log('🔍 [Azure DI OCR] Using W2-specific patterns...');
    
    // === EMPLOYEE NAME PATTERNS ===
    const namePatterns = [
      // W2_EMPLOYEE_NAME_PRECISE: Extract from "e Employee's first name and initial Last name [NAME]"
      {
        name: 'W2_EMPLOYEE_NAME_PRECISE',
        pattern: /e\s+Employee'?s?\s+first\s+name\s+and\s+initial\s+Last\s+name\s+([A-Za-z\s]+?)(?:\s+\d|\n|f\s+Employee'?s?\s+address|$)/i,
        example: "e Employee's first name and initial Last name Michelle Hicks"
      },
      // EMPLOYEE_NAME_MULTILINE: Extract name that appears after "Employee's name" label
      {
        name: 'EMPLOYEE_NAME_MULTILINE',
        pattern: /(?:Employee'?s?\s+name|EMPLOYEE'?S?\s+NAME)\s*\n([A-Za-z\s]+?)(?:\n|$)/i,
        example: "Employee's name\nJordan Blake"
      },
      // EMPLOYEE_NAME_BASIC: Basic employee name extraction
      {
        name: 'EMPLOYEE_NAME_BASIC',
        pattern: /(?:Employee'?s?\s+name|EMPLOYEE'?S?\s+NAME)[:\s]+([A-Za-z\s]+?)(?:\s+\d|\n|Employee'?s?\s+|EMPLOYEE'?S?\s+|SSN|address|street|$)/i,
        example: "Employee's name JOHN DOE"
      },
      {
        name: 'EMPLOYEE_NAME_COLON',
        pattern: /(?:Employee'?s?\s+name|EMPLOYEE'?S?\s+NAME):\s*([A-Za-z\s]+?)(?:\n|Employee'?s?\s+|EMPLOYEE'?S?\s+|SSN|address|street|$)/i,
        example: "Employee's name: JOHN DOE"
      }
    ];
    
    // Try name patterns
    for (const patternInfo of namePatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        const name = match[1].trim();
        if (name.length > 2 && /^[A-Za-z\s]+$/.test(name)) {
          personalInfo.name = name;
          console.log(`✅ [Azure DI OCR] Found name using ${patternInfo.name}:`, name);
          break;
        }
      }
    }
    
    // === SSN PATTERNS ===
    const ssnPatterns = [
      {
        name: 'SSN_BASIC',
        pattern: /(?:Employee'?s?\s+SSN|EMPLOYEE'?S?\s+SSN|SSN)[:\s]*(\d{3}[-\s]?\d{2}[-\s]?\d{4})/i,
        example: "Employee's SSN: 123-45-6789"
      },
      {
        name: 'SSN_MULTILINE',
        pattern: /(?:Employee'?s?\s+SSN|EMPLOYEE'?S?\s+SSN|SSN)\s*\n(\d{3}[-\s]?\d{2}[-\s]?\d{4})/i,
        example: "Employee's SSN\n123-45-6789"
      },
      {
        name: 'SSN_STANDALONE',
        pattern: /\b(\d{3}[-\s]\d{2}[-\s]\d{4})\b/,
        example: "123-45-6789"
      }
    ];
    
    // Try SSN patterns
    for (const patternInfo of ssnPatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        const ssn = match[1].trim();
        if (ssn.length >= 9) {
          personalInfo.ssn = ssn;
          console.log(`✅ [Azure DI OCR] Found SSN using ${patternInfo.name}:`, ssn);
          break;
        }
      }
    }
    
    // === ADDRESS PATTERNS ===
    const addressPatterns = [
      // W2_ADDRESS_SPLIT: Extract split address from W2 form (street after name, city/state/zip later)
      {
        name: 'W2_ADDRESS_SPLIT',
        pattern: /e\s+Employee'?s?\s+first\s+name\s+and\s+initial\s+Last\s+name\s+[A-Za-z\s]+\s+([0-9]+\s+[A-Za-z\s]+(?:Apt\.?\s*\d+)?)\s+.*?([A-Za-z\s]+\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)/is,
        example: "e Employee's first name and initial Last name Michelle Hicks 0121 Gary Islands Apt. 691 ... Sandraport UT 35155-6840"
      },
      // W2_ADDRESS_PRECISE: Extract from W2 form structure with specific line breaks
      {
        name: 'W2_ADDRESS_PRECISE',
        pattern: /([0-9]+\s+[A-Za-z\s]+(?:Apt\.?\s*\d+)?)\s+([A-Za-z\s]+)\s+([A-Z]{2})\s+(\d{5}(?:-\d{4})?)/i,
        example: "0121 Gary Islands Apt. 691 Sandraport UT 35155-6840"
      },
      // W2_ADDRESS_MULTILINE: Extract address that spans multiple lines after employee name
      {
        name: 'W2_ADDRESS_MULTILINE',
        pattern: /(?:Employee'?s?\s+first\s+name.*?)\n([0-9]+\s+[A-Za-z\s]+(?:Apt\.?\s*\d+)?)\s*\n?([A-Za-z\s]+\s+[A-Z]{2}\s+\d{5}(?:-\d{4})?)/i,
        example: "Employee's first name and initial Last name Michelle Hicks\n0121 Gary Islands Apt. 691\nSandraport UT 35155-6840"
      },
      {
        name: 'ADDRESS_MULTILINE',
        pattern: /(?:Employee'?s?\s+address|EMPLOYEE'?S?\s+ADDRESS)\s*\n([^\n]+(?:\n[^\n]+)*?)(?:\n\s*\n|Employer'?s?\s+|EMPLOYER'?S?\s+|$)/i,
        example: "Employee's address\n123 Main St\nAnytown, ST 12345"
      },
      {
        name: 'ADDRESS_BASIC',
        pattern: /(?:Employee'?s?\s+address|EMPLOYEE'?S?\s+ADDRESS)[:\s]+([^\n]+(?:\n[^\n]+)*?)(?:\n\s*\n|Employer'?s?\s+|EMPLOYER'?S?\s+|$)/i,
        example: "Employee's address: 123 Main St, Anytown, ST 12345"
      }
    ];
    
    // Try address patterns
    for (const patternInfo of addressPatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match) {
        let address = '';
        
        if (patternInfo.name === 'W2_ADDRESS_SPLIT') {
          // For split pattern: [street] [city state zip]
          if (match[1] && match[2]) {
            address = `${match[1].trim()} ${match[2].trim()}`;
          }
        } else if (patternInfo.name === 'W2_ADDRESS_PRECISE') {
          // For precise pattern: [street] [city] [state] [zip]
          if (match[1] && match[2] && match[3] && match[4]) {
            address = `${match[1]} ${match[2]} ${match[3]} ${match[4]}`;
          }
        } else if (patternInfo.name === 'W2_ADDRESS_MULTILINE') {
          // For multiline pattern: [street] [city state zip]
          if (match[1] && match[2]) {
            address = `${match[1]} ${match[2]}`;
          }
        } else if (match[1]) {
          // For other patterns: use first capture group
          address = match[1].trim().replace(/\n+/g, ' ');
        }
        
        if (address.length > 5) {
          personalInfo.address = address.trim();
          console.log(`✅ [Azure DI OCR] Found address using ${patternInfo.name}:`, address);
          break;
        }
      }
    }
    
    // === EMPLOYER NAME PATTERNS ===
    const employerNamePatterns = [
      {
        name: 'EMPLOYER_NAME_MULTILINE',
        pattern: /(?:Employer'?s?\s+name|EMPLOYER'?S?\s+NAME)\s*\n([A-Za-z\s&.,'-]+?)(?:\n|$)/i,
        example: "Employer's name\nAcme Corporation"
      },
      {
        name: 'EMPLOYER_NAME_BASIC',
        pattern: /(?:Employer'?s?\s+name|EMPLOYER'?S?\s+NAME)[:\s]+([A-Za-z\s&.,'-]+?)(?:\s+\d|\n|Employer'?s?\s+|EMPLOYER'?S?\s+|EIN|address|street|$)/i,
        example: "Employer's name ACME CORPORATION"
      }
    ];
    
    // Try employer name patterns
    for (const patternInfo of employerNamePatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        const name = match[1].trim();
        if (name.length > 2) {
          personalInfo.employerName = name;
          console.log(`✅ [Azure DI OCR] Found employer name using ${patternInfo.name}:`, name);
          break;
        }
      }
    }
    
    // === EMPLOYER ADDRESS PATTERNS ===
    const employerAddressPatterns = [
      {
        name: 'EMPLOYER_ADDRESS_MULTILINE',
        pattern: /(?:Employer'?s?\s+address|EMPLOYER'?S?\s+ADDRESS)\s*\n([^\n]+(?:\n[^\n]+)*?)(?:\n\s*\n|Control\s+number|$)/i,
        example: "Employer's address\n456 Business Ave\nBusiness City, ST 67890"
      },
      {
        name: 'EMPLOYER_ADDRESS_BASIC',
        pattern: /(?:Employer'?s?\s+address|EMPLOYER'?S?\s+ADDRESS)[:\s]+([^\n]+(?:\n[^\n]+)*?)(?:\n\s*\n|Control\s+number|$)/i,
        example: "Employer's address: 456 Business Ave, Business City, ST 67890"
      }
    ];
    
    // Try employer address patterns
    for (const patternInfo of employerAddressPatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        const address = match[1].trim().replace(/\n+/g, ' ');
        if (address.length > 5) {
          personalInfo.employerAddress = address;
          console.log(`✅ [Azure DI OCR] Found employer address using ${patternInfo.name}:`, address);
          break;
        }
      }
    }
    
    return personalInfo;
  }

  /**
   * Enhanced address parsing that extracts city, state, and zip code from a full address string
   * Uses both the address string and OCR text for better accuracy
   */
  private extractAddressParts(fullAddress: string, ocrText: string): {
    street?: string;
    city?: string;
    state?: string;
    zipCode?: string;
  } {
    console.log('🔍 [Azure DI OCR] Parsing address parts from:', fullAddress);
    
    const addressParts: {
      street?: string;
      city?: string;
      state?: string;
      zipCode?: string;
    } = {};
    
    // Clean up the address string
    const cleanAddress = fullAddress.replace(/\s+/g, ' ').trim();
    
    // Pattern 1: Standard format "Street, City, ST ZIP"
    const standardPattern = /^(.+?),\s*([^,]+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i;
    let match = cleanAddress.match(standardPattern);
    
    if (match) {
      addressParts.street = match[1].trim();
      addressParts.city = match[2].trim();
      addressParts.state = match[3].toUpperCase();
      addressParts.zipCode = match[4];
      console.log('✅ [Azure DI OCR] Parsed using standard pattern');
      return addressParts;
    }
    
    // Pattern 2: "Street City, ST ZIP"
    const noCommaPattern = /^(.+?)\s+([^,]+?),\s*([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/i;
    match = cleanAddress.match(noCommaPattern);
    
    if (match) {
      const streetAndCity = match[1].trim();
      const lastCity = match[2].trim();
      
      // Try to split street and city
      const streetCityParts = streetAndCity.split(/\s+/);
      if (streetCityParts.length > 2) {
        // Assume last 1-2 words before the comma are city
        const cityWords = streetCityParts.slice(-2);
        const streetWords = streetCityParts.slice(0, -2);
        
        addressParts.street = streetWords.join(' ');
        addressParts.city = `${cityWords.join(' ')} ${lastCity}`.trim();
      } else {
        addressParts.street = streetAndCity;
        addressParts.city = lastCity;
      }
      
      addressParts.state = match[3].toUpperCase();
      addressParts.zipCode = match[4];
      console.log('✅ [Azure DI OCR] Parsed using no-comma pattern');
      return addressParts;
    }
    
    // Pattern 3: Extract ZIP code first, then work backwards
    const zipPattern = /(\d{5}(?:-\d{4})?)/;
    const zipMatch = cleanAddress.match(zipPattern);
    
    if (zipMatch) {
      addressParts.zipCode = zipMatch[1];
      
      // Extract state (2 letters before ZIP)
      const statePattern = /([A-Z]{2})\s+\d{5}(?:-\d{4})?/i;
      const stateMatch = cleanAddress.match(statePattern);
      
      if (stateMatch) {
        addressParts.state = stateMatch[1].toUpperCase();
        
        // Everything before state is street and city
        const beforeState = cleanAddress.substring(0, stateMatch.index).trim();
        
        // Try to split into street and city
        const parts = beforeState.split(',');
        if (parts.length >= 2) {
          addressParts.street = parts[0].trim();
          addressParts.city = parts[1].trim();
        } else {
          // Try to split by common city indicators
          const cityPattern = /^(.+?)\s+((?:[A-Z][a-z]+\s*)+)$/;
          const cityMatch = beforeState.match(cityPattern);
          
          if (cityMatch) {
            addressParts.street = cityMatch[1].trim();
            addressParts.city = cityMatch[2].trim();
          } else {
            // Fallback: assume everything is street
            addressParts.street = beforeState;
          }
        }
      }
      
      console.log('✅ [Azure DI OCR] Parsed using ZIP-first pattern');
      return addressParts;
    }
    
    // Pattern 4: Try to extract from OCR text context
    if (ocrText) {
      console.log('🔍 [Azure DI OCR] Attempting to extract address parts from OCR context...');
      
      // Look for ZIP codes in the OCR text near the address
      const ocrZipMatches = ocrText.match(/\d{5}(?:-\d{4})?/g);
      if (ocrZipMatches) {
        // Use the first ZIP code found
        addressParts.zipCode = ocrZipMatches[0];
        
        // Look for state abbreviations near the ZIP
        const statePattern = new RegExp(`([A-Z]{2})\\s+${addressParts.zipCode}`, 'i');
        const stateMatch = ocrText.match(statePattern);
        
        if (stateMatch) {
          addressParts.state = stateMatch[1].toUpperCase();
        }
      }
      
      // If we still don't have city, try to extract from the original address
      if (!addressParts.city && addressParts.state) {
        const beforeState = fullAddress.replace(new RegExp(`\\s*${addressParts.state}.*$`, 'i'), '');
        const parts = beforeState.split(',');
        
        if (parts.length >= 2) {
          addressParts.street = parts[0].trim();
          addressParts.city = parts[parts.length - 1].trim();
        }
      }
    }
    
    // Fallback: if we couldn't parse properly, at least try to get the street
    if (!addressParts.street && !addressParts.city) {
      // Remove ZIP and state from the end
      let remaining = cleanAddress;
      if (addressParts.zipCode) {
        remaining = remaining.replace(new RegExp(`\\s*${addressParts.zipCode}$`), '');
      }
      if (addressParts.state) {
        remaining = remaining.replace(new RegExp(`\\s*${addressParts.state}\\s*$`, 'i'), '');
      }
      
      addressParts.street = remaining.trim();
      console.log('⚠️ [Azure DI OCR] Used fallback parsing');
    }
    
    return addressParts;
  }

  /**
   * Enhanced wages extraction from W2 OCR text using multiple patterns and validation
   */
  private extractWagesFromOCR(ocrText: string): number {
    console.log('🔍 [Azure DI OCR] Extracting wages from OCR text...');
    
    // Multiple patterns for Box 1 wages
    const wagePatterns = [
      // Pattern 1: "1 Wages, tips, other compensation" followed by amount
      {
        name: 'BOX_1_STANDARD',
        pattern: /1\s+Wages,?\s*tips,?\s*other\s+compensation\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        example: "1 Wages, tips, other compensation\n$50,000.00"
      },
      // Pattern 2: Just "1" followed by amount
      {
        name: 'BOX_1_SIMPLE',
        pattern: /(?:^|\n)\s*1\s+\$?([0-9,]+\.?\d{0,2})/m,
        example: "1 50000.00"
      },
      // Pattern 3: "Box 1" followed by amount
      {
        name: 'BOX_1_EXPLICIT',
        pattern: /Box\s*1[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
        example: "Box 1: $50,000.00"
      },
      // Pattern 4: "Wages" followed by amount
      {
        name: 'WAGES_KEYWORD',
        pattern: /Wages[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
        example: "Wages: $50,000.00"
      }
    ];
    
    for (const patternInfo of wagePatterns) {
      const match = ocrText.match(patternInfo.pattern);
      if (match && match[1]) {
        const amountStr = match[1].replace(/,/g, '');
        const amount = parseFloat(amountStr);
        
        // Validate the amount (should be reasonable for wages)
        if (!isNaN(amount) && amount > 0 && amount < 10000000) { // Max $10M
          console.log(`✅ [Azure DI OCR] Found wages using ${patternInfo.name}: $${amount}`);
          return amount;
        }
      }
    }
    
    console.log('⚠️ [Azure DI OCR] Could not extract wages from OCR text');
    return 0;
  }

  // === OCR-BASED EXTRACTION METHODS ===
  
  private extractW2FieldsFromOCR(ocrText: string, baseData: ExtractedFieldData): ExtractedFieldData {
    console.log('🔍 [Azure DI OCR] Extracting W2 fields from OCR text...');
    
    const w2Data = { ...baseData };
    
    // Extract personal information
    const personalInfo = this.extractPersonalInfoFromOCR(ocrText);
    if (personalInfo.name) w2Data.employeeName = personalInfo.name;
    if (personalInfo.ssn) w2Data.employeeSSN = personalInfo.ssn;
    if (personalInfo.address) w2Data.employeeAddress = personalInfo.address;
    if (personalInfo.employerName) w2Data.employerName = personalInfo.employerName;
    if (personalInfo.employerAddress) w2Data.employerAddress = personalInfo.employerAddress;
    
    // Extract wages
    const wages = this.extractWagesFromOCR(ocrText);
    if (wages > 0) w2Data.wages = wages;
    
    // Extract other W2 amounts using patterns
    const amountPatterns = {
      federalTaxWithheld: [
        /2\s+Federal\s+income\s+tax\s+withheld\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*2\s+\$?([0-9,]+\.?\d{0,2})/m
      ],
      socialSecurityWages: [
        /3\s+Social\s+security\s+wages\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*3\s+\$?([0-9,]+\.?\d{0,2})/m
      ],
      socialSecurityTaxWithheld: [
        /4\s+Social\s+security\s+tax\s+withheld\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*4\s+\$?([0-9,]+\.?\d{0,2})/m
      ],
      medicareWages: [
        /5\s+Medicare\s+wages\s+and\s+tips\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*5\s+\$?([0-9,]+\.?\d{0,2})/m
      ],
      medicareTaxWithheld: [
        /6\s+Medicare\s+tax\s+withheld\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*6\s+\$?([0-9,]+\.?\d{0,2})/m
      ]
    };
    
    for (const [fieldName, patterns] of Object.entries(amountPatterns)) {
      for (const pattern of patterns) {
        const match = ocrText.match(pattern);
        if (match && match[1]) {
          const amountStr = match[1].replace(/,/g, '');
          const amount = parseFloat(amountStr);
          
          if (!isNaN(amount) && amount >= 0) {
            w2Data[fieldName] = amount;
            console.log(`✅ [Azure DI OCR] Found ${fieldName}: $${amount}`);
            break;
          }
        }
      }
    }
    
    return w2Data;
  }

  private extract1099IntFieldsFromOCR(ocrText: string, baseData: ExtractedFieldData): ExtractedFieldData {
    console.log('🔍 [Azure DI OCR] Extracting 1099-INT fields from OCR text...');
    
    const data = { ...baseData };
    
    // Extract personal information using 1099-specific patterns
    const personalInfo = this.extractPersonalInfoFromOCR(ocrText);
    if (personalInfo.name) data.recipientName = personalInfo.name;
    if (personalInfo.tin) data.recipientTIN = personalInfo.tin;
    if (personalInfo.address) data.recipientAddress = personalInfo.address;
    if (personalInfo.payerName) data.payerName = personalInfo.payerName;
    if (personalInfo.payerTIN) data.payerTIN = personalInfo.payerTIN;
    
    // Extract 1099-INT specific amounts
    const amountPatterns = {
      interestIncome: [
        /1\s+Interest\s+income\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*1\s+\$?([0-9,]+\.?\d{0,2})/m
      ],
      earlyWithdrawalPenalty: [
        /2\s+Early\s+withdrawal\s+penalty\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*2\s+\$?([0-9,]+\.?\d{0,2})/m
      ],
      federalTaxWithheld: [
        /4\s+Federal\s+income\s+tax\s+withheld\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*4\s+\$?([0-9,]+\.?\d{0,2})/m
      ]
    };
    
    for (const [fieldName, patterns] of Object.entries(amountPatterns)) {
      for (const pattern of patterns) {
        const match = ocrText.match(pattern);
        if (match && match[1]) {
          const amountStr = match[1].replace(/,/g, '');
          const amount = parseFloat(amountStr);
          
          if (!isNaN(amount) && amount >= 0) {
            data[fieldName] = amount;
            console.log(`✅ [Azure DI OCR] Found ${fieldName}: $${amount}`);
            break;
          }
        }
      }
    }
    
    return data;
  }

  private extract1099DivFieldsFromOCR(ocrText: string, baseData: ExtractedFieldData): ExtractedFieldData {
    console.log('🔍 [Azure DI OCR] Extracting 1099-DIV fields from OCR text...');
    
    const data = { ...baseData };
    
    // Extract personal information using 1099-specific patterns
    const personalInfo = this.extractPersonalInfoFromOCR(ocrText);
    if (personalInfo.name) data.recipientName = personalInfo.name;
    if (personalInfo.tin) data.recipientTIN = personalInfo.tin;
    if (personalInfo.address) data.recipientAddress = personalInfo.address;
    if (personalInfo.payerName) data.payerName = personalInfo.payerName;
    if (personalInfo.payerTIN) data.payerTIN = personalInfo.payerTIN;
    
    // Extract 1099-DIV specific amounts
    const amountPatterns = {
      ordinaryDividends: [
        /1a\s+Ordinary\s+dividends\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*1a\s+\$?([0-9,]+\.?\d{0,2})/m
      ],
      qualifiedDividends: [
        /1b\s+Qualified\s+dividends\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*1b\s+\$?([0-9,]+\.?\d{0,2})/m
      ],
      totalCapitalGain: [
        /2a\s+Total\s+capital\s+gain\s+distributions\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*2a\s+\$?([0-9,]+\.?\d{0,2})/m
      ],
      federalTaxWithheld: [
        /4\s+Federal\s+income\s+tax\s+withheld\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*4\s+\$?([0-9,]+\.?\d{0,2})/m
      ]
    };
    
    for (const [fieldName, patterns] of Object.entries(amountPatterns)) {
      for (const pattern of patterns) {
        const match = ocrText.match(pattern);
        if (match && match[1]) {
          const amountStr = match[1].replace(/,/g, '');
          const amount = parseFloat(amountStr);
          
          if (!isNaN(amount) && amount >= 0) {
            data[fieldName] = amount;
            console.log(`✅ [Azure DI OCR] Found ${fieldName}: $${amount}`);
            break;
          }
        }
      }
    }
    
    return data;
  }

  private extract1099MiscFieldsFromOCR(ocrText: string, baseData: ExtractedFieldData): ExtractedFieldData {
    console.log('🔍 [Azure DI OCR] Extracting 1099-MISC fields from OCR text...');
    
    const data = { ...baseData };
    
    // Extract personal information using 1099-specific patterns
    const personalInfo = this.extractPersonalInfoFromOCR(ocrText);
    if (personalInfo.name) data.recipientName = personalInfo.name;
    if (personalInfo.tin) data.recipientTIN = personalInfo.tin;
    if (personalInfo.address) data.recipientAddress = personalInfo.address;
    if (personalInfo.payerName) data.payerName = personalInfo.payerName;
    if (personalInfo.payerTIN) data.payerTIN = personalInfo.payerTIN;
    if (personalInfo.payerAddress) data.payerAddress = personalInfo.payerAddress;
    
    // Enhanced account number extraction with more patterns
    const accountNumberPatterns = [
      /Account\s+number[:\s]*([A-Z0-9\-]+)/i,
      /Acct\s*#[:\s]*([A-Z0-9\-]+)/i,
      /Account[:\s]*([A-Z0-9\-]+)/i,
      /Account\s+number.*?:\s*([A-Z0-9\-]+)/i,
      /Account\s+number.*?\s+([A-Z0-9\-]+)/i
    ];
    
    for (const pattern of accountNumberPatterns) {
      const match = ocrText.match(pattern);
      if (match && match[1] && match[1].trim() !== 'number') {
        data.accountNumber = match[1].trim();
        console.log(`✅ [Azure DI OCR] Found account number: ${data.accountNumber}`);
        break;
      }
    }
    
    // Comprehensive 1099-MISC box patterns (boxes 1-18)
    const amountPatterns = {
      // Box 1 - Rents
      rents: [
        /1\s+Rents\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*1\s+\$?([0-9,]+\.?\d{0,2})/m,
        /Box\s*1[:\s]*\$?([0-9,]+\.?\d{0,2})/i
      ],
      // Box 2 - Royalties
      royalties: [
        /2\s+Royalties\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*2\s+\$?([0-9,]+\.?\d{0,2})/m,
        /Box\s*2[:\s]*\$?([0-9,]+\.?\d{0,2})/i
      ],
      // Box 3 - Other income
      otherIncome: [
        /3\s+Other\s+income\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*3\s+\$?([0-9,]+\.?\d{0,2})/m,
        /Box\s*3[:\s]*\$?([0-9,]+\.?\d{0,2})/i
      ],
      // Box 4 - Federal income tax withheld
      federalTaxWithheld: [
        /4\s+Federal\s+income\s+tax\s+withheld\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*4\s+\$?([0-9,]+\.?\d{0,2})/m,
        /Box\s*4[:\s]*\$?([0-9,]+\.?\d{0,2})/i
      ],
      // Box 5 - Fishing boat proceeds
      fishingBoatProceeds: [
        /5\s+Fishing\s+boat\s+proceeds\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*5\s+\$?([0-9,]+\.?\d{0,2})/m,
        /Box\s*5[:\s]*\$?([0-9,]+\.?\d{0,2})/i
      ],
      // Box 6 - Medical and health care payments
      medicalHealthPayments: [
        /6\s+Medical\s+and\s+health\s+care\s+payments\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /6\s+Medical\s+payments\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*6\s+\$?([0-9,]+\.?\d{0,2})/m,
        /Box\s*6[:\s]*\$?([0-9,]+\.?\d{0,2})/i
      ],
      // Box 7 - Nonemployee compensation (deprecated but may still appear)
      nonemployeeCompensation: [
        /7\s+Nonemployee\s+compensation\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*7\s+\$?([0-9,]+\.?\d{0,2})/m,
        /Box\s*7[:\s]*\$?([0-9,]+\.?\d{0,2})/i
      ],
      // Box 8 - Substitute payments in lieu of dividends or interest
      substitutePayments: [
        /8\s+Substitute\s+payments\s+in\s+lieu\s+of\s+dividends\s+or\s+interest\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /8\s+Substitute\s+payments\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*8\s+\$?([0-9,]+\.?\d{0,2})/m,
        /Box\s*8[:\s]*\$?([0-9,]+\.?\d{0,2})/i
      ],
      // Box 9 - Crop insurance proceeds
      cropInsuranceProceeds: [
        /9\s+Crop\s+insurance\s+proceeds\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*9\s+\$?([0-9,]+\.?\d{0,2})/m,
        /Box\s*9[:\s]*\$?([0-9,]+\.?\d{0,2})/i
      ],
      // Box 10 - Gross proceeds paid to an attorney
      attorneyProceeds: [
        /10\s+Gross\s+proceeds\s+paid\s+to\s+an\s+attorney\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /10\s+Attorney\s+proceeds\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*10\s+\$?([0-9,]+\.?\d{0,2})/m,
        /Box\s*10[:\s]*\$?([0-9,]+\.?\d{0,2})/i
      ],
      // Box 11 - Fish purchased for resale
      fishPurchases: [
        /11\s+Fish\s+purchased\s+for\s+resale\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*11\s+\$?([0-9,]+\.?\d{0,2})/m,
        /Box\s*11[:\s]*\$?([0-9,]+\.?\d{0,2})/i
      ],
      // Box 12 - Section 409A deferrals
      section409ADeferrals: [
        /12\s+Section\s+409A\s+deferrals\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*12\s+\$?([0-9,]+\.?\d{0,2})/m,
        /Box\s*12[:\s]*\$?([0-9,]+\.?\d{0,2})/i
      ],
      // Box 13 - Excess golden parachute payments
      excessGoldenParachutePayments: [
        /13\s+Excess\s+golden\s+parachute\s+payments\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*13\s+\$?([0-9,]+\.?\d{0,2})/m,
        /Box\s*13[:\s]*\$?([0-9,]+\.?\d{0,2})/i
      ],
      // Box 14 - Nonqualified deferred compensation
      nonqualifiedDeferredCompensation: [
        /14\s+Nonqualified\s+deferred\s+compensation\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*14\s+\$?([0-9,]+\.?\d{0,2})/m,
        /Box\s*14[:\s]*\$?([0-9,]+\.?\d{0,2})/i
      ],
      // Box 15a - Section 409A income
      section409AIncome: [
        /15a\s+Section\s+409A\s+income\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*15a\s+\$?([0-9,]+\.?\d{0,2})/m,
        /Box\s*15a[:\s]*\$?([0-9,]+\.?\d{0,2})/i
      ],
      // Box 16 - State tax withheld
      stateTaxWithheld: [
        /16\s+State\s+tax\s+withheld\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*16\s+\$?([0-9,]+\.?\d{0,2})/m,
        /Box\s*16[:\s]*\$?([0-9,]+\.?\d{0,2})/i
      ],
      // Box 17 - State/Payer's state no.
      statePayerNumber: [
        /17\s+State\/Payer's\s+state\s+no\.\s*[\n\s]*([A-Z0-9\-\s]+)/i,
        /(?:^|\n)\s*17\s+([A-Z0-9\-\s]+)/m,
        /Box\s*17[:\s]*([A-Z0-9\-\s]+)/i
      ],
      // Box 18 - State income
      stateIncome: [
        /18\s+State\s+income\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*18\s+\$?([0-9,]+\.?\d{0,2})/m,
        /Box\s*18[:\s]*\$?([0-9,]+\.?\d{0,2})/i
      ]
    };
    
    // Extract all box amounts
    for (const [fieldName, patterns] of Object.entries(amountPatterns)) {
      for (const pattern of patterns) {
        const match = ocrText.match(pattern);
        if (match && match[1]) {
          let value: string | number = match[1];
          
          // Handle numeric fields
          if (fieldName !== 'statePayerNumber') {
            const amountStr = match[1].replace(/,/g, '');
            const amount = parseFloat(amountStr);
            
            if (!isNaN(amount) && amount >= 0) {
              value = amount;
              console.log(`✅ [Azure DI OCR] Found ${fieldName}: $${amount}`);
            } else {
              continue; // Skip invalid amounts
            }
          } else {
            // Handle text fields like state payer number
            value = match[1].trim();
            console.log(`✅ [Azure DI OCR] Found ${fieldName}: ${value}`);
          }
          
          data[fieldName] = value;
          break;
        }
      }
    }
    
    // Extract additional medical payment amounts (Box 6 can have multiple values)
    const medicalPaymentPattern = /medical.*?payments?.*?\$?([0-9,]+\.?\d{0,2})/gi;
    const medicalPayments = [];
    let medicalMatch;
    
    while ((medicalMatch = medicalPaymentPattern.exec(ocrText)) !== null) {
      const amountStr = medicalMatch[1].replace(/,/g, '');
      const amount = parseFloat(amountStr);
      
      if (!isNaN(amount) && amount > 0) {
        medicalPayments.push(amount);
      }
    }
    
    if (medicalPayments.length > 1) {
      data.medicalPaymentsMultiple = medicalPayments;
      console.log(`✅ [Azure DI OCR] Found multiple medical payments: ${medicalPayments.join(', ')}`);
    }
    
    return data;
  }

  private extract1099NecFieldsFromOCR(ocrText: string, baseData: ExtractedFieldData): ExtractedFieldData {
    console.log('🔍 [Azure DI OCR] Extracting 1099-NEC fields from OCR text...');
    
    const data = { ...baseData };
    
    // Extract personal information using 1099-specific patterns
    const personalInfo = this.extractPersonalInfoFromOCR(ocrText);
    if (personalInfo.name) data.recipientName = personalInfo.name;
    if (personalInfo.tin) data.recipientTIN = personalInfo.tin;
    if (personalInfo.address) data.recipientAddress = personalInfo.address;
    if (personalInfo.payerName) data.payerName = personalInfo.payerName;
    if (personalInfo.payerTIN) data.payerTIN = personalInfo.payerTIN;
    
    // Extract 1099-NEC specific amounts
    const amountPatterns = {
      nonemployeeCompensation: [
        /1\s+Nonemployee\s+compensation\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*1\s+\$?([0-9,]+\.?\d{0,2})/m
      ],
      federalTaxWithheld: [
        /4\s+Federal\s+income\s+tax\s+withheld\s*[\n\s]*\$?([0-9,]+\.?\d{0,2})/i,
        /(?:^|\n)\s*4\s+\$?([0-9,]+\.?\d{0,2})/m
      ]
    };
    
    for (const [fieldName, patterns] of Object.entries(amountPatterns)) {
      for (const pattern of patterns) {
        const match = ocrText.match(pattern);
        if (match && match[1]) {
          const amountStr = match[1].replace(/,/g, '');
          const amount = parseFloat(amountStr);
          
          if (!isNaN(amount) && amount >= 0) {
            data[fieldName] = amount;
            console.log(`✅ [Azure DI OCR] Found ${fieldName}: $${amount}`);
            break;
          }
        }
      }
    }
    
    return data;
  }

  private extractGenericFieldsFromOCR(ocrText: string, baseData: ExtractedFieldData): ExtractedFieldData {
    console.log('🔍 [Azure DI OCR] Extracting generic fields from OCR text...');
    
    const data = { ...baseData };
    
    // Extract any monetary amounts found in the text
    const amountPattern = /\$?([0-9,]+\.?\d{0,2})/g;
    const amounts = [];
    let match;
    
    while ((match = amountPattern.exec(ocrText)) !== null) {
      const amountStr = match[1].replace(/,/g, '');
      const amount = parseFloat(amountStr);
      
      if (!isNaN(amount) && amount > 0) {
        amounts.push(amount);
      }
    }
    
    if (amounts.length > 0) {
      data.extractedAmountsCount = amounts.length;
      data.firstAmount = amounts[0];
      console.log(`✅ [Azure DI OCR] Found ${amounts.length} monetary amounts`);
    }
    
    return data;
  }

  // === UTILITY METHODS ===
  
  private parseAmount(value: any): number {
    if (typeof value === 'number') {
      return value;
    }
    
    if (typeof value === 'string') {
      // Remove currency symbols and commas
      const cleanValue = value.replace(/[$,]/g, '');
      const parsed = parseFloat(cleanValue);
      return isNaN(parsed) ? 0 : parsed;
    }
    
    return 0;
  }
}

// Factory function to create service instance
export function getAzureDocumentIntelligenceService(): AzureDocumentIntelligenceService {
  const endpoint = process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT;
  const apiKey = process.env.AZURE_DOCUMENT_INTELLIGENCE_API_KEY;
  
  if (!endpoint || !apiKey) {
    throw new Error('Azure Document Intelligence configuration missing');
  }
  
  return new AzureDocumentIntelligenceService({
    endpoint,
    apiKey
  });
}
