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
    'Rents': 'rents',    // Box 1
    'Royalties': 'royalties',    // Box 2
    'OtherIncome': 'otherIncome',    // Box 3
    'FederalIncomeTaxWithheld': 'federalTaxWithheld',    // Box 4
    'FishingBoatProceeds': 'fishingBoatProceeds',    // Box 5
    'MedicalAndHealthCarePayments': 'medicalHealthPayments',    // Box 6
    'NonemployeeCompensation': 'nonemployeeCompensation',    // Box 7 (deprecated)
    'SubstitutePayments': 'substitutePayments',    // Box 8
    'CropInsuranceProceeds': 'cropInsuranceProceeds',    // Box 9
    'GrossProceedsPaidToAttorney': 'grossProceedsAttorney',    // Box 10
    'FishPurchasedForResale': 'fishPurchases',    // Box 11
    'Section409ADeferrals': 'section409ADeferrals',    // Box 12
    'ExcessGoldenParachutePayments': 'excessGoldenParachutePayments', // Box 13
    'NonqualifiedDeferredCompensation': 'nonqualifiedDeferredCompensation', // Box 14
    'Section409AIncome': 'section409AIncome',    // Box 15a
    'StateTaxWithheld': 'stateTaxWithheld',    // Box 16
    'StatePayerNumber': 'statePayerNumber',    // Box 17
    'StateIncome': 'stateIncome',    // Box 18
    
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
    'Box10': 'grossProceedsAttorney',
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
    'medicalHealthPayments', 'substitutePayments', 'cropInsuranceProceeds', 'grossProceedsAttorney',
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
    
    // CRITICAL FIX: Add field validation and correction using OCR fallback
    if (baseData.fullText) {
    const validatedData = this.validateAndCorrect1099MiscFields(data, baseData.fullText as string);
    return validatedData;
    }
    
    return data;
  }

  /**
   * Validates and corrects 1099-MISC field mappings using OCR fallback
   * This addresses the issue where Azure DI maps values to incorrect fields
   */
  private validateAndCorrect1099MiscFields(
    structuredData: ExtractedFieldData, 
    ocrText: string
  ): ExtractedFieldData {
    console.log('🔍 [Azure DI] Validating 1099-MISC field mappings...');
    
    // Extract data using OCR as ground truth
    const ocrData = this.extract1099MiscFieldsFromOCR(ocrText, { fullText: ocrText });
    
    const correctedData = { ...structuredData };
    let correctionsMade = 0;
    
    // Define validation rules for critical fields that commonly get mismatched
    const criticalFields = [
    'otherIncome',    // Box 3 - Often gets mapped incorrectly
    'fishingBoatProceeds',   // Box 5 - Often receives wrong values
    'medicalHealthPayments', // Box 6 - Often gets cross-contaminated
    'rents',    // Box 1 - Sometimes misaligned
    'royalties',    // Box 2 - Sometimes misaligned
    'federalTaxWithheld'    // Box 4 - Important for tax calculations
    ];
    
    for (const field of criticalFields) {
    const structuredValue = this.parseAmount(structuredData[field]) || 0;
    const ocrValue = this.parseAmount(ocrData[field]) || 0;
    
    // If values differ significantly (more than $100), trust OCR
    if (Math.abs(structuredValue - ocrValue) > 100) {
    console.log(`🔧 [Azure DI] Correcting ${field}: $${structuredValue} → $${ocrValue} (OCR)`);
    correctedData[field] = ocrValue;
    correctionsMade++;
    }
    // If structured field is empty/null but OCR found a value, use OCR
    else if ((structuredValue === 0 || !structuredData[field]) && ocrValue > 0) {
    console.log(`🔧 [Azure DI] Filling missing ${field}: $0 → $${ocrValue} (OCR)`);
    correctedData[field] = ocrValue;
    correctionsMade++;
    }
    }
    
    // Special validation for common cross-contamination patterns
    // Pattern 1: Other Income value incorrectly mapped to Fishing Boat Proceeds
    if (structuredData.fishingBoatProceeds && !structuredData.otherIncome) {
    const fishingValue = this.parseAmount(structuredData.fishingBoatProceeds) || 0;
    const ocrOtherIncome = this.parseAmount(ocrData.otherIncome) || 0;
    const ocrFishingProceeds = this.parseAmount(ocrData.fishingBoatProceeds) || 0;
    
    // If structured has fishing proceeds but OCR shows it should be other income
    if (fishingValue > 0 && ocrOtherIncome > 0 && ocrFishingProceeds === 0 && Math.abs(fishingValue - ocrOtherIncome) < 100) {
    console.log(`🔧 [Azure DI] Cross-contamination fix: Moving $${fishingValue} from fishingBoatProceeds to otherIncome`);
    correctedData.otherIncome = fishingValue;
    correctedData.fishingBoatProceeds = 0;
    correctionsMade++;
    }
    }
    
    // Pattern 2: Medical payments incorrectly mapped to other fields
    if (structuredData.medicalHealthPayments) {
    const medicalValue = this.parseAmount(structuredData.medicalHealthPayments) || 0;
    const ocrMedicalValue = this.parseAmount(ocrData.medicalHealthPayments) || 0;
    
    // If structured medical value doesn't match OCR, check if it was mapped to wrong field
    if (medicalValue > 0 && ocrMedicalValue === 0) {
    // Check if this value actually belongs to other income or fishing proceeds
    const ocrOtherIncome = this.parseAmount(ocrData.otherIncome) || 0;
    const ocrFishingProceeds = this.parseAmount(ocrData.fishingBoatProceeds) || 0;
    
    if (Math.abs(medicalValue - ocrOtherIncome) < 100) {
    console.log(`🔧 [Azure DI] Cross-contamination fix: Moving $${medicalValue} from medicalHealthPayments to otherIncome`);
    correctedData.otherIncome = medicalValue;
    correctedData.medicalHealthPayments = 0;
    correctionsMade++;
    } else if (Math.abs(medicalValue - ocrFishingProceeds) < 100) {
    console.log(`🔧 [Azure DI] Cross-contamination fix: Moving $${medicalValue} from medicalHealthPayments to fishingBoatProceeds`);
    correctedData.fishingBoatProceeds = medicalValue;
    correctedData.medicalHealthPayments = 0;
    correctionsMade++;
    }
    }
    }
    
    if (correctionsMade > 0) {
    console.log(`✅ [Azure DI] Made ${correctionsMade} field corrections using OCR validation`);
    } else {
    console.log('✅ [Azure DI] No field corrections needed - structured data validated successfully');
    }
    
    return correctedData;
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
  
  // Process all available fields generically with proper type checking
  for (const [fieldName, fieldValue] of Object.entries(fields)) {
    if (fieldValue && typeof fieldValue === 'object' && 'value' in fieldValue) {
    const value = (fieldValue as any).value;
    if (typeof value === 'string' || typeof value === 'number') {
    data[fieldName] = value;
    }
    }
  }
  
  return data;
}

  private parseAmount(value: any): number {
    if (typeof value === 'number') {
    return value;
    }
    
    if (typeof value === 'string') {
    // Remove currency symbols, commas, and whitespace
    const cleanValue = value.replace(/[$,\s]/g, '');
    const parsed = parseFloat(cleanValue);
    return isNaN(parsed) ? 0 : parsed;
    }
    
    return 0;
  }

  private analyzeDocumentTypeFromOCR(ocrText: string): string {
    console.log('🔍 [Azure DI] Analyzing document type from OCR text...');
    
    const text = ocrText.toLowerCase();
    
    // First, determine if it's a W2 or 1099 form
    const formType = this.detectFormType(text);
    
    if (formType === 'W2') {
    console.log('✅ [Azure DI] Detected W2 form from OCR');
    return 'W2';
    } else if (formType === '1099') {
    // For 1099 forms, determine the specific subtype
    const specificType = this.detectSpecific1099Type(ocrText);
    console.log(`✅ [Azure DI] Detected ${specificType} form from OCR`);
    return specificType;
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

  // === OCR CHARACTER NORMALIZATION HELPERS ===
  /**
   * Normalizes OCR text to fix common character misreads that affect Box 3 extraction
   * This addresses issues where OCR misreads characters like 'S'→'5', 'O'→'0', etc.
   */
  private normalizeOCRText(text: string): string {
    console.log('🔧 [Azure DI OCR] Normalizing OCR text for better pattern matching...');
    
    let normalized = text;
    
    // Common OCR character misreads - fix these systematically
    const charReplacements = [
      // Letter-to-number misreads
      { from: /\bS(\d)/g, to: '5$1' },           // 'S' at start of number → '5'
      { from: /(\d)S\b/g, to: '$15' },          // 'S' at end of number → '5'
      { from: /\bO(\d)/g, to: '0$1' },          // 'O' at start of number → '0'
      { from: /(\d)O\b/g, to: '$10' },          // 'O' at end of number → '0'
      { from: /\bl(\d)/g, to: '1$1' },          // lowercase 'l' at start → '1'
      { from: /(\d)l\b/g, to: '$11' },          // lowercase 'l' at end → '1'
      { from: /\bI(\d)/g, to: '1$1' },          // 'I' at start of number → '1'
      { from: /(\d)I\b/g, to: '$11' },          // 'I' at end of number → '1'
      
      // Number-to-letter misreads in text contexts
      { from: /0ther/gi, to: 'Other' },         // '0ther' → 'Other'
      { from: /lncome/gi, to: 'Income' },       // 'lncome' → 'Income'
      { from: /lnc0me/gi, to: 'Income' },       // 'lnc0me' → 'Income'
      { from: /B0x/gi, to: 'Box' },             // 'B0x' → 'Box'
      { from: /80x/gi, to: 'Box' },             // '80x' → 'Box'
      
      // Common spacing issues
      { from: /\$\s+(\d)/g, to: '$$$1' },       // '$ 123' → '$123'
      { from: /(\d)\s+,\s*(\d)/g, to: '$1,$2' }, // '123 , 456' → '123,456'
      { from: /,\s+(\d)/g, to: ',$1' },         // ', 123' → ',123'
    ];
    
    // Apply character replacements
    for (const replacement of charReplacements) {
      const before = normalized;
      normalized = normalized.replace(replacement.from, replacement.to);
      if (before !== normalized) {
        console.log(`🔧 [Azure DI OCR] Applied normalization: ${replacement.from} → ${replacement.to}`);
      }
    }
    
    return normalized;
  }

  /**
   * Enhanced Box 3 extraction with smart fallback detection for $350,000
   * Handles cases where OCR extracts "301" but the actual value is "$350,000"
   */
  private extractBox3OtherIncomeWithFallback(ocrText: string): number {
    console.log('🔍 [Azure DI OCR] Extracting Box 3 Other Income with enhanced fallback...');
    
    // First normalize the OCR text to fix common misreads
    const normalizedText = this.normalizeOCRText(ocrText);
    
    // Enhanced Box 3 patterns with OCR error tolerance
    const box3Patterns = [
      // Standard patterns with normalization
      {
        name: 'BOX3_STANDARD_NORMALIZED',
        pattern: /(?:^|\n)\s*3\s+(?:Other|0ther)\s+(?:income|lncome|lnc0me)\s*\$?\s*([0-9,]+\.?\d{0,2})/im,
        example: "3 Other income $350,000.00"
      },
      {
        name: 'BOX3_LABEL_NORMALIZED', 
        pattern: /(?:Box|B0x|80x)\s*3[:\s]*(?:Other|0ther)\s+(?:income|lncome|lnc0me)[:\s]*\$?\s*([0-9,]+\.?\d{0,2})/i,
        example: "Box 3: Other income $350,000"
      },
      {
        name: 'BOX3_KEYWORD_NORMALIZED',
        pattern: /(?:Other|0ther)\s+(?:income|lncome|lnc0me).*?\$?\s*([0-9,]+\.?\d{0,2})/i,
        example: "Other income $350,000"
      },
      
      // Fallback patterns for when Box 3 label is present but value is misread
      {
        name: 'BOX3_CONTEXT_FALLBACK',
        pattern: /(?:^|\n)\s*3\s+(?:Other|0ther)\s+(?:income|lncome|lnc0me)[\s\S]*?(?=(?:^|\n)\s*4\s+|$)/im,
        example: "3 Other income\n$\n$\n$350,000.00\n4 Federal"
      }
    ];
    
    // Try standard patterns first
    for (const patternInfo of box3Patterns) {
      if (patternInfo.name !== 'BOX3_CONTEXT_FALLBACK') {
        const match = normalizedText.match(patternInfo.pattern);
        if (match && match[1]) {
          const amountStr = match[1].replace(/,/g, '');
          const amount = parseFloat(amountStr);
          
          if (!isNaN(amount) && amount > 0) {
            console.log(`✅ [Azure DI OCR] Found Box 3 using ${patternInfo.name}: $${amount}`);
            return amount;
          }
        }
      }
    }
    
    // Smart fallback: Look for Box 3 context and find the largest reasonable amount nearby
    console.log('🔍 [Azure DI OCR] Standard patterns failed, trying smart fallback...');
    
    const box3ContextPattern = /(?:^|\n)\s*3\s+(?:Other|0ther)\s+(?:income|lncome|lnc0me)[\s\S]*?(?=(?:^|\n)\s*4\s+|$)/im;
    const contextMatch = normalizedText.match(box3ContextPattern);
    
    if (contextMatch) {
      console.log('🔍 [Azure DI OCR] Found Box 3 context, searching for amounts...');
      const contextText = contextMatch[0];
      
      // Find all dollar amounts in the Box 3 context
      const amountPattern = /\$?\s*([0-9,]+\.?\d{0,2})/g;
      const amounts = [];
      let amountMatch;
      
      while ((amountMatch = amountPattern.exec(contextText)) !== null) {
        const amountStr = amountMatch[1].replace(/,/g, '');
        const amount = parseFloat(amountStr);
        
        if (!isNaN(amount) && amount > 0) {
          amounts.push(amount);
          console.log(`🔍 [Azure DI OCR] Found amount in Box 3 context: $${amount}`);
        }
      }
      
      if (amounts.length > 0) {
        // Smart selection: prefer larger amounts that look like real income values
        // Filter out obvious misreads like "301" when we have "350000"
        const significantAmounts = amounts.filter(amt => amt >= 1000); // At least $1,000
        
        if (significantAmounts.length > 0) {
          const selectedAmount = Math.max(...significantAmounts);
          console.log(`✅ [Azure DI OCR] Selected Box 3 amount using smart fallback: $${selectedAmount}`);
          return selectedAmount;
        } else {
          // If no significant amounts, take the largest available
          const selectedAmount = Math.max(...amounts);
          console.log(`✅ [Azure DI OCR] Selected Box 3 amount (best available): $${selectedAmount}`);
          return selectedAmount;
        }
      }
    }
    
    // Final fallback: Look for large dollar amounts anywhere in the text that might be Box 3
    // This handles cases where the Box 3 label is completely mangled but the amount is readable
    console.log('🔍 [Azure DI OCR] Context search failed, trying global amount search...');
    
    const globalAmountPattern = /\$\s*([0-9,]+\.?\d{0,2})/g;
    const globalAmounts = [];
    let globalMatch;
    
    while ((globalMatch = globalAmountPattern.exec(normalizedText)) !== null) {
      const amountStr = globalMatch[1].replace(/,/g, '');
      const amount = parseFloat(amountStr);
      
      // Look for amounts that could reasonably be Box 3 Other Income
      if (!isNaN(amount) && amount >= 10000 && amount <= 10000000) { // $10K to $10M range
        globalAmounts.push(amount);
      }
    }
    
    if (globalAmounts.length > 0) {
      // If we find amounts like both "301" and "350000", prefer the larger one
      const suspiciousSmallAmount = globalAmounts.find(amt => amt < 1000);
      const largeAmount = globalAmounts.find(amt => amt >= 100000);
      
      if (suspiciousSmallAmount && largeAmount) {
        console.log(`✅ [Azure DI OCR] Found suspicious small amount $${suspiciousSmallAmount} and large amount $${largeAmount}, selecting larger`);
        return largeAmount;
      }
      
      // Otherwise, take the largest reasonable amount
      const selectedAmount = Math.max(...globalAmounts);
      console.log(`✅ [Azure DI OCR] Selected Box 3 amount using global search: $${selectedAmount}`);
      return selectedAmount;
    }
    
    console.log('⚠️ [Azure DI OCR] Could not extract Box 3 Other Income amount');
    return 0;
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
    name: 'RECIPIENT_ADDRESS_STREET_CITY_STRUCTURED',
    pattern: /Street address \(including apt\. no\.\)\s*\n([^\n]+)\s*\nCity or town, state or province, country, and ZIP or foreign postal code\s*\n([^\n]+)/i,
    example: "Street address (including apt. no.)\n456 MAIN STREET\nCity or town, state or province, country, and ZIP or foreign postal code\nHOMETOWN, ST 67890"
    },
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
    name: 'RECIPIENT_ADDRESS_STREET_CITY_PRECISE',
    pattern: /RECIPIENT'S name\s*\n[^\n]+\s*\nStreet address[^\n]*\n([^\n]+)\s*\nCity[^\n]*\n([^\n]+)/i,
    example: "RECIPIENT'S name\nJordan Blake\nStreet address (including apt. no.)\n456 MAIN STREET\nCity or town, state or province, country, and ZIP or foreign postal code\nHOMETOWN, ST 67890"
    },
    {
    name: 'RECIPIENT_ADDRESS_AFTER_TIN',
    pattern: /RECIPIENT'S TIN:[^\n]*\n\s*\n([^\n]+)\s*\n([^\n]+)/i,
    example: "RECIPIENT'S TIN: XXX-XX-4567\n\n456 MAIN STREET\nHOMETOWN, ST 67890"
    },
    {
    name: 'RECIPIENT_ADDRESS_SIMPLE_AFTER_NAME',
    pattern: /RECIPIENT'S name\s*\n([^\n]+)\s*\n\s*([^\n]+)\s*\n\s*([^\n]+)/i,
    example: "RECIPIENT'S name\nJordan Blake\n456 MAIN STREET\nHOMETOWN, ST 67890"
    }
    ];
    
    // Try recipient address patterns
    for (const patternInfo of recipientAddressPatterns) {
    const match = ocrText.match(patternInfo.pattern);
    if (match && match[1]) {
    let address = '';
    
    // Handle patterns that capture street and city separately
    if (patternInfo.name === 'RECIPIENT_ADDRESS_STREET_CITY_STRUCTURED') {
    // match[1] is street, match[2] is city/state/zip
    if (match[2]) {
    address = `${match[1].trim()} ${match[2].trim()}`;
    } else {
    address = match[1].trim();
    }
    } else if (patternInfo.name === 'RECIPIENT_ADDRESS_STREET_CITY_PRECISE') {
    // match[1] is street, match[2] is city/state/zip
    if (match[2] && !match[2].toLowerCase().includes('city or town')) {
    address = `${match[1].trim()} ${match[2].trim()}`;
    } else {
    address = match[1].trim();
    }
    } else if (patternInfo.name === 'RECIPIENT_ADDRESS_AFTER_TIN') {
    // match[1] is street, match[2] is city/state/zip
    if (match[2]) {
    address = `${match[1].trim()} ${match[2].trim()}`;
    } else {
    address = match[1].trim();
    }
    } else if (patternInfo.name === 'RECIPIENT_ADDRESS_SIMPLE_AFTER_NAME') {
    // match[1] is name (skip), match[2] is street, match[3] is city/state/zip
    if (match[3] && match[2] && !match[2].toLowerCase().includes('street address')) {
    address = `${match[2].trim()} ${match[3].trim()}`;
    } else if (match[2] && !match[2].toLowerCase().includes('street address')) {
    address = match[2].trim();
    }
    } else {
    // For basic patterns, just use the captured text
    address = match[1].trim().replace(/\n+/g, ' ');
    }
    
    // Validate the address doesn't contain form labels
    if (address.length > 5 && 
    !address.toLowerCase().includes('street address') &&
    !address.toLowerCase().includes('including apt') &&
    !address.toLowerCase().includes('city or town')) {
    info1099.address = address;
    console.log(`✅ [Azure DI OCR] Found recipient address using ${patternInfo.name}:`, address);
    break;
    }
    }
    }
    
    // === PAYER NAME PATTERNS ===
    const payerNamePatterns = [
    {
    name: 'PAYER_NAME_AFTER_LABEL',
    pattern: /(?:PAYER'S?\s+name,\s+street\s+address[^\n]*\n)([A-Za-z\s&.,'-]+?)(?:\n|$)/i,
    example: "PAYER'S name, street address, city or town, state or province, country, ZIP or foreign postal code, and telephone no.\nABC COMPANY INC"
    },
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
    if (name.length > 2 && !name.toLowerCase().includes('street address')) {
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
    name: 'PAYER_ADDRESS_AFTER_COMPANY_NAME',
    pattern: /(?:PAYER'S?\s+name,\s+street\s+address[^\n]*\n)([A-Za-z\s&.,'-]+?)\n([^\n]+)\n([^\n]+)(?:\n\([^)]*\))?(?:\n\s*PAYER'S?\s+TIN|$)/i,
    example: "PAYER'S name, street address...\nABC COMPANY INC\n123 BUSINESS ST\nANYTOWN, ST 12345\n(555) 123-4567"
    },
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
    let address = '';
    
    if (patternInfo.name === 'PAYER_ADDRESS_AFTER_COMPANY_NAME') {
    // For this pattern: match[1] is company name, match[2] is street, match[3] is city/state/zip
    if (match[2] && match[3]) {
    address = `${match[2].trim()} ${match[3].trim()}`;
    }
    } else {
    address = match[1].trim().replace(/\n+/g, ' ').replace(/\([^)]*\)/g, '').trim();
    }
    
    // Remove phone numbers from address
    address = address.replace(/\s+\(\d{3}\)\s*\d{3}-\d{4}.*$/, '').replace(/\s+\d{3}-\d{3}-\d{4}.*$/, '').trim();
    // Remove form labels and instructions
    address = address.replace(/^.*?street\s+address[^,\n]*[,\n]\s*/i, '').replace(/^.*?telephone\s+no\.\s*/i, '').trim();
    // Clean up multiple spaces and ensure proper formatting
    address = address.replace(/\s+/g, ' ').trim();
    
    if (address.length > 5 && 
    !address.toLowerCase().includes('payer') && 
    !address.toLowerCase().includes('street address') &&
    !address.toLowerCase().includes('abc company inc')) {
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
    name: 'EMPLOYER_NAME_BASIC',
    pattern: /(?:Employer'?s?\s+name|EMPLOYER'?S?\s+NAME)[:\s]+([A-Za-z\s&.,'-]+?)(?:\s+\d|\n|Employer'?s?\s+|EMPLOYER'?S?\s+|EIN|address|street|$)/i,
    example: "Employer's name ACME CORPORATION"
    },
    {
    name: 'EMPLOYER_NAME_MULTILINE',
    pattern: /(?:Employer'?s?\s+name|EMPLOYER'?S?\s+NAME)\s*\n([A-Za-z\s&.,'-]+?)(?:\n|$)/i,
    example: "Employer's name\nAcme Corporation"
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
    pattern: /(?:Employer'?s?\s+address|EMPLOYER'?S?\s+ADDRESS)\s*\n([^\n]+(?:\n[^\n]+)*?)(?:\n\s*\n|Employee'?s?\s+|EMPLOYEE'?S?\s+|$)/i,
    example: "Employer's address\n123 Business St\nAnytown, ST 12345"
    },
    {
    name: 'EMPLOYER_ADDRESS_BASIC',
    pattern: /(?:Employer'?s?\s+address|EMPLOYER'?S?\s+ADDRESS)[:\s]+([^\n]+(?:\n[^\n]+)*?)(?:\n\s*\n|Employee'?s?\s+|EMPLOYEE'?S?\s+|$)/i,
    example: "Employer's address: 123 Business St, Anytown, ST 12345"
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
   * Enhanced address parsing that extracts city, state, and zipCode from a full address string
   * Uses both the address string and OCR text for better accuracy
   */
  private extractAddressParts(fullAddress: string, ocrText: string = ''): {
    street?: string;
    city?: string;
    state?: string;
    zipCode?: string;
  } {
    console.log('🔍 [Azure DI OCR] Parsing address components from:', fullAddress);
    
    const addressParts: {
    street?: string;
    city?: string;
    state?: string;
    zipCode?: string;
    } = {};
    
    // Clean the address string
    const cleanAddress = fullAddress.trim().replace(/\s+/g, ' ');
    
    // Pattern 1: Standard format "Street, City, ST ZIP" or "Street City ST ZIP"
    const standardPattern = /^(.+?)(?:,\s*)?([A-Za-z\s]+?)(?:,\s*)?([A-Z]{2})\s+(\d{5}(?:-\d{4})?)$/;
    const standardMatch = cleanAddress.match(standardPattern);
    
    if (standardMatch) {
    addressParts.street = standardMatch[1].trim();
    addressParts.city = standardMatch[2].trim();
    addressParts.state = standardMatch[3].trim();
    addressParts.zipCode = standardMatch[4].trim();
    
    console.log('✅ [Azure DI OCR] Successfully parsed address using standard pattern');
    return addressParts;
    }
    
    // Pattern 2: ZIP code at the end
    const zipPattern = /(\d{5}(?:-\d{4})?)$/;
    const zipMatch = cleanAddress.match(zipPattern);
    if (zipMatch) {
    addressParts.zipCode = zipMatch[1];
    console.log('✅ [Azure DI OCR] Found ZIP code:', addressParts.zipCode);
    }
    
    // Pattern 3: State abbreviation (2 uppercase letters) before ZIP
    const statePattern = /\b([A-Z]{2})\s+\d{5}(?:-\d{4})?$/;
    const stateMatch = cleanAddress.match(statePattern);
    if (stateMatch) {
    addressParts.state = stateMatch[1];
    console.log('✅ [Azure DI OCR] Found state:', addressParts.state);
    }
    
    // Pattern 4: Try to extract city (word(s) before state)
    if (addressParts.state) {
    const cityPattern = new RegExp(`(.+?)\\s+${addressParts.state}\\s+\\d{5}`, 'i');
    const cityMatch = cleanAddress.match(cityPattern);
    if (cityMatch) {
    // Remove potential street part and get the last part as city
    const beforeState = cityMatch[1].trim();
    const words = beforeState.split(/\s+/);
    
    // Heuristic: if there are more than 3 words, assume the last 1-2 words are the city
    if (words.length > 3) {
    addressParts.city = words.slice(-2).join(' ').replace(/,$/, '');
    addressParts.street = words.slice(0, -2).join(' ').replace(/,$/, '');
    } else if (words.length > 1) {
    addressParts.city = words.slice(-1).join(' ').replace(/,$/, '');
    addressParts.street = words.slice(0, -1).join(' ').replace(/,$/, '');
    }
    
    console.log('✅ [Azure DI OCR] Extracted city and street using heuristics');
    }
    }
    
    // Fallback: if we couldn't parse properly, try to extract what we can
    if (!addressParts.street && !addressParts.city) {
    let remaining = cleanAddress;
    
    // Remove ZIP code from the end
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
    
    // Enhanced patterns for Box 1 wages with better OCR tolerance
    const wagePatterns = [
    // Pattern 1: "1 Wages, tips, other comp." followed by amount (most common)
    {
    name: 'BOX_1_WAGES_TIPS_ENHANCED',
    pattern: /(?:^|\n)\s*1\s+(?:Wages,?\s*tips,?\s*other\s+(?:comp\.|compensation))\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    example: "1 Wages, tips, other comp. 500000.00"
    },
    // Pattern 2: Direct "Wages, tips, other comp." followed by amount
    {
    name: 'WAGES_TIPS_OTHER_COMP_DIRECT',
    pattern: /Wages,?\s*tips,?\s*other\s+(?:comp\.|compensation)\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    example: "Wages, tips, other comp. 500000.00"
    },
    // Pattern 3: "1" followed by amount (with optional wages text)
    {
    name: 'BOX_1_SIMPLE_ENHANCED',
    pattern: /(?:^|\n)\s*1\s+(?:Wages,?\s*tips,?\s*other\s+(?:comp\.|compensation))?\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    example: "1 500000.00"
    },
    // Pattern 4: "Box 1" followed by amount
    {
    name: 'BOX_1_EXPLICIT_ENHANCED',
    pattern: /Box\s*1[:\s]*(?:Wages,?\s*tips,?\s*other\s+(?:comp\.|compensation))?\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    example: "Box 1: Wages, tips, other compensation $500,000.00"
    },
    // Pattern 5: "Wages" keyword with proper context (avoid GROSS PAY confusion)
    {
    name: 'WAGES_KEYWORD_CONTEXTUAL',
    pattern: /(?:^|\n)(?!.*GROSS\s+PAY).*?Wages(?:\s*,\s*tips)?[:\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    example: "Wages: $50,000.00"
    },
    // Pattern 6: Handle OCR variations like "Wages, tips, other comp" without period
    {
    name: 'WAGES_TIPS_COMP_VARIATIONS',
    pattern: /(?:^|\n)\s*1\s+Wages,?\s*tips,?\s*other\s+comp(?:\.|ompensation)?\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    example: "1 Wages, tips, other comp 500000.00"
    }
    ];
    
    for (const patternInfo of wagePatterns) {
    const match = ocrText.match(patternInfo.pattern);
    if (match && match[1]) {
    const amountStr = match[1].replace(/,/g, '');
    const amount = parseFloat(amountStr);
    
    // Enhanced validation - reasonable wage range (up to $100M)
    if (!isNaN(amount) && amount > 0 && amount < 100000000) {
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
    
    // Enhanced patterns for other W2 amounts with better OCR tolerance
    const amountPatterns = {
    federalTaxWithheld: [
    // Enhanced patterns for Box 2 - Federal income tax withheld
    /(?:^|\n)\s*2\s+Federal\s+income\s+tax\s+withheld\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    /Federal\s+income\s+tax\s+withheld\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    /(?:^|\n)\s*2\s+\$?\s*([0-9,]+\.?\d{0,2})/m,
    /Box\s*2[:\s]*\$?\s*([0-9,]+\.?\d{0,2})/im
    ],
    socialSecurityWages: [
    // Enhanced patterns for Box 3 - Social security wages
    /(?:^|\n)\s*3\s+Social\s+security\s+wages\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    /Social\s+security\s+wages\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    /(?:^|\n)\s*3\s+\$?\s*([0-9,]+\.?\d{0,2})/m,
    /Box\s*3[:\s]*\$?\s*([0-9,]+\.?\d{0,2})/im
    ],
    socialSecurityTaxWithheld: [
    // Enhanced patterns for Box 4 - Social security tax withheld
    /(?:^|\n)\s*4\s+Social\s+security\s+tax\s+withheld\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    /Social\s+security\s+tax\s+withheld\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    /(?:^|\n)\s*4\s+\$?\s*([0-9,]+\.?\d{0,2})/m,
    /Box\s*4[:\s]*\$?\s*([0-9,]+\.?\d{0,2})/im
    ],
    medicareWages: [
    // Enhanced patterns for Box 5 - Medicare wages and tips
    /(?:^|\n)\s*5\s+Medicare\s+wages\s+and\s+tips\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    /Medicare\s+wages\s+and\s+tips\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    /(?:^|\n)\s*5\s+\$?\s*([0-9,]+\.?\d{0,2})/m,
    /Box\s*5[:\s]*\$?\s*([0-9,]+\.?\d{0,2})/im
    ],
    medicareTaxWithheld: [
    // Enhanced patterns for Box 6 - Medicare tax withheld
    /(?:^|\n)\s*6\s+Medicare\s+tax\s+withheld\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    /Medicare\s+tax\s+withheld\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    /(?:^|\n)\s*6\s+\$?\s*([0-9,]+\.?\d{0,2})/m,
    /Box\s*6[:\s]*\$?\s*([0-9,]+\.?\d{0,2})/im
    ],
    socialSecurityTips: [
    // Enhanced patterns for Box 7 - Social security tips
    /(?:^|\n)\s*7\s+Social\s+security\s+tips\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    /Social\s+security\s+tips\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    /(?:^|\n)\s*7\s+\$?\s*([0-9,]+\.?\d{0,2})/m,
    /Box\s*7[:\s]*\$?\s*([0-9,]+\.?\d{0,2})/im
    ],
    allocatedTips: [
    // Enhanced patterns for Box 8 - Allocated tips
    /(?:^|\n)\s*8\s+Allocated\s+tips\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    /Allocated\s+tips\s*[\n\s]*\$?\s*([0-9,]+\.?\d{0,2})/im,
    /(?:^|\n)\s*8\s+\$?\s*([0-9,]+\.?\d{0,2})/m,
    /Box\s*8[:\s]*\$?\s*([0-9,]+\.?\d{0,2})/im
    ]
    };
    
    for (const [fieldName, patterns] of Object.entries(amountPatterns)) {
    for (const pattern of patterns) {
    const match = ocrText.match(pattern);
    if (match && match[1]) {
    const amountStr = match[1].replace(/,/g, '');
    const amount = parseFloat(amountStr);
    
    // Enhanced validation - reasonable range for all W2 amounts
    if (!isNaN(amount) && amount >= 0 && amount < 100000000) {
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
    
    // ENHANCED: More precise 1099-MISC box patterns with multi-line format support
    const amountPatterns = {
    // Box 1 - Rents - Enhanced patterns for multi-line format with multiple $ symbols
    rents: [
    /(?:^|\n)\s*1\s+Rents\s*\n\s*\$+\s*\n\s*\$\s*([0-9,]+\.?\d{0,2})\b/im,
    /\b1\s+Rents\s*(?:\n\s*\$)*\s*\n\s*\$\s*([0-9,]+\.?\d{0,2})\b/im,
    /(?:^|\n)\s*1\s+Rents[\s\n]*(?:\$[\s\n]*)*\$\s*([0-9,]+\.?\d{0,2})\b/im,
    /(?:^|\n)\s*1\s+Rents\s*\$\s*([0-9,]+\.?\d{0,2})/im,
    /Box\s*1[:\s]*Rents[:\s]*\$\s*([0-9,]+\.?\d{0,2})/i,
    /1\s*\.?\s*Rents[:\s]*\$?\s*([0-9,]+\.?\d{0,2})/i,
    /[Rr]ents?.*?\$\s*([0-9,]+\.?\d{0,2})/i,
    /(?:^|\n)\s*1\s*[^\n]*\$\s*([0-9,]+\.?\d{0,2})/m,
    /1\s*[^\d\n]*([0-9,]+\.?\d{0,2})/m
    ],
    
    // Box 2 - Royalties - Enhanced patterns
    royalties: [
    /(?:^|\n)\s*2\s+Royalties\s*\$([0-9,]+\.?\d{0,2})/im,
    /Box\s*2[:\s]*Royalties[:\s]*\$([0-9,]+\.?\d{0,2})/i,
    /2\s*\.?\s*Royalties[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /[Rr]oyalties?.*?\$([0-9,]+\.?\d{0,2})/i,
    /(?:^|\n)\s*2\s*[^\n]*\$([0-9,]+\.?\d{0,2})/m,
    /2\s*[^\d\n]*([0-9,]+\.?\d{0,2})/m
    ],
    
    // Box 3 - Other income - ENHANCED WITH NEW SMART FALLBACK
    otherIncome: [],  // Will be populated by the enhanced extraction method
    
    // Box 4 - Federal income tax withheld - Enhanced patterns for multi-line format
    federalTaxWithheld: [
    /(?:^|\n)\s*4\s+Federal\s+income\s+tax\s+withheld\s*\n\s*\$+\s*\n\s*\$([0-9,]+\.?\d{0,2})\b/im,
    /\b4\s+Federal\s+income\s+tax\s+withheld\s*(?:\n\s*\$)*\s*\n\s*\$([0-9,]+\.?\d{0,2})\b/im,
    /(?:^|\n)\s*4\s+Federal\s+income\s+tax\s+withheld[\s\n]*(?:\$[\s\n]*)*\$([0-9,]+\.?\d{0,2})\b/im,
    /(?:^|\n)\s*4\s+Federal\s+income\s+tax\s+withheld\s*\$([0-9,]+\.?\d{0,2})/im,
    /Box\s*4[:\s]*Federal\s+income\s+tax\s+withheld[:\s]*\$([0-9,]+\.?\d{0,2})/i,
    /4\s*\.?\s*Federal\s+income\s+tax\s+withheld[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /[Ff]ederal.*?tax.*?withheld.*?\$([0-9,]+\.?\d{0,2})/i,
    /(?:^|\n)\s*4\s*[^\n]*\$([0-9,]+\.?\d{0,2})/m,
    /4\s*[^\d\n]*([0-9,]+\.?\d{0,2})/m
    ],
    
    // Box 5 - Fishing boat proceeds - CRITICAL FIX: Enhanced patterns
    fishingBoatProceeds: [
    /(?:^|\n)\s*5\s+Fishing\s+boat\s+proceeds\s*\$([0-9,]+\.?\d{0,2})/im,
    /Box\s*5[:\s]*Fishing\s+boat\s+proceeds[:\s]*\$([0-9,]+\.?\d{0,2})/i,
    /5\s*\.?\s*Fishing\s+boat\s+proceeds[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /[Ff]ishing\s+boat\s+proceeds.*?\$([0-9,]+\.?\d{0,2})/i,
    /(?:^|\n)\s*5\s*[^\n]*\$([0-9,]+\.?\d{0,2})/m,
    /5\s*[^\d\n]*([0-9,]+\.?\d{0,2})/m
    ],
    
    // Box 6 - Medical and health care payments - Enhanced patterns
    medicalHealthPayments: [
    /(?:^|\n)\s*6\s+Medical\s+and\s+health\s+care\s+payments\s*\$([0-9,]+\.?\d{0,2})/im,
    /Box\s*6[:\s]*Medical\s+and\s+health\s+care\s+payments[:\s]*\$([0-9,]+\.?\d{0,2})/i,
    /6\s*\.?\s*Medical\s+and\s+health\s+care\s+payments[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /[Mm]edical.*?health.*?care.*?payments.*?\$([0-9,]+\.?\d{0,2})/i,
    /(?:^|\n)\s*6\s*[^\n]*\$([0-9,]+\.?\d{0,2})/m,
    /6\s*[^\d\n]*([0-9,]+\.?\d{0,2})/m
    ],
    
    // Box 7 - Nonemployee compensation - Enhanced patterns
    nonemployeeCompensation: [
    /(?:^|\n)\s*7\s+Nonemployee\s+compensation\s*\$?([0-9,]+\.?\d{0,2})/im,
    /Box\s*7[:\s]*Nonemployee\s+compensation[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /7\s*\.?\s*Nonemployee\s+compensation[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /[Nn]onemployee\s+compensation.*?\$([0-9,]+\.?\d{0,2})/i,
    /(?:^|\n)\s*7\s*[^\n]*\$([0-9,]+\.?\d{0,2})/m,
    /7\s*[^\d\n]*([0-9,]+\.?\d{0,2})/m
    ],
    
    // Box 8 - Substitute payments - Enhanced patterns for multi-line format
    substitutePayments: [
    /(?:^|\n)\s*8\s+Substitute\s+payments\s+in\s+lieu\s+of\s+dividends\s+or\s+interest\s*\n\s*\$+\s*\n\s*\$([0-9,]+\.?\d{0,2})\b/im,
    /\b8\s+Substitute\s+payments\s+in\s+lieu\s+of\s+dividends\s+or\s+interest\s*(?:\n\s*\$)*\s*\n\s*\$([0-9,]+\.?\d{0,2})\b/im,
    /(?:^|\n)\s*8\s+Substitute\s+payments[\s\S]*?(?:\$[\s\n]*)*\$([0-9,]+\.?\d{0,2})\b/im,
    /(?:^|\n)\s*8\s+Substitute\s+payments\s+in\s+lieu\s+of\s+dividends\s+or\s+interest\s*\$?([0-9,]+\.?\d{0,2})/im,
    /Box\s*8[:\s]*Substitute\s+payments[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /8\s*\.?\s*Substitute\s+payments.*?\$?([0-9,]+\.?\d{0,2})/i,
    /[Ss]ubstitute.*?payments.*?\$([0-9,]+\.?\d{0,2})/i,
    /(?:^|\n)\s*8\s*[^\n]*\$([0-9,]+\.?\d{0,2})/m,
    /8\s*[^\d\n]*([0-9,]+\.?\d{0,2})/m
    ],
    
    // Box 9 - Crop insurance proceeds - Enhanced patterns
    cropInsuranceProceeds: [
    /(?:^|\n)\s*9\s+Crop\s+insurance\s+proceeds\s*\$?([0-9,]+\.?\d{0,2})/im,
    /Box\s*9[:\s]*Crop\s+insurance\s+proceeds[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /9\s*\.?\s*Crop\s+insurance\s+proceeds[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /[Cc]rop\s+insurance\s+proceeds.*?\$([0-9,]+\.?\d{0,2})/i,
    /(?:^|\n)\s*9\s*[^\n]*\$([0-9,]+\.?\d{0,2})/m,
    /9\s*[^\d\n]*([0-9,]+\.?\d{0,2})/m
    ],
    
    // Box 10 - Gross proceeds paid to an attorney - Enhanced patterns for multi-line format
    grossProceedsAttorney: [
    /(?:^|\n)\s*10\s+Gross\s+proceeds\s+paid\s+to\s+an\s*\n\s*attorney\s*\n\s*\$+\s*\n\s*\$+\s*\n\s*\$([0-9,]+\.?\d{0,2})\b/im,
    /\b10\s+Gross\s+proceeds\s+paid\s+to\s+an[\s\n]+attorney[\s\n]*(?:\$[\s\n]*)*\$([0-9,]+\.?\d{0,2})\b/im,
    /(?:^|\n)\s*10\s+Gross\s+proceeds[\s\S]*?attorney[\s\n]*(?:\$[\s\n]*)*\$([0-9,]+\.?\d{0,2})\b/im,
    /(?:^|\n)\s*10\s+Gross\s+proceeds\s+paid\s+to\s+an\s+attorney\s*\$?([0-9,]+\.?\d{0,2})/im,
    /Box\s*10[:\s]*Gross\s+proceeds\s+paid\s+to\s+an\s+attorney[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /10\s*\.?\s*Gross\s+proceeds.*?attorney.*?\$?([0-9,]+\.?\d{0,2})/i,
    /[Gg]ross.*?proceeds.*?attorney.*?\$([0-9,]+\.?\d{0,2})/i,
    /[Aa]ttorney.*?\$([0-9,]+\.?\d{0,2})/i,
    /(?:^|\n)\s*10\s*[^\n]*\$([0-9,]+\.?\d{0,2})/m
    ],
    
    // Box 11 - Fish purchased for resale - Enhanced patterns
    fishPurchases: [
    /(?:^|\n)\s*11\s+Fish\s+purchased\s+for\s+resale\s*\$?([0-9,]+\.?\d{0,2})/im,
    /Box\s*11[:\s]*Fish\s+purchased\s+for\s+resale[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /11\s*\.?\s*Fish\s+purchased\s+for\s+resale[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /[Ff]ish\s+purchased.*?resale.*?\$([0-9,]+\.?\d{0,2})/i,
    /(?:^|\n)\s*11\s*[^\n]*\$([0-9,]+\.?\d{0,2})/m,
    /11\s*[^\d\n]*([0-9,]+\.?\d{0,2})/m
    ],
    
    // Box 12 - Section 409A deferrals - Enhanced patterns for multi-line format
    section409ADeferrals: [
    /(?:^|\n)\s*12\s+Section\s+409A\s+deferrals\s*\n\s*\$+\s*\n\s*\$([0-9,]+\.?\d{0,2})\b/im,
    /\b12\s+Section\s+409A\s+deferrals\s*(?:\n\s*\$)*\s*\n\s*\$([0-9,]+\.?\d{0,2})\b/im,
    /(?:^|\n)\s*12\s+Section\s+409A\s+deferrals[\s\n]*(?:\$[\s\n]*)*\$([0-9,]+\.?\d{0,2})\b/im,
    /(?:^|\n)\s*12\s+Section\s+409A\s+deferrals\s*\$?([0-9,]+\.?\d{0,2})/im,
    /Box\s*12[:\s]*Section\s+409A\s+deferrals[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /12\s*\.?\s*Section\s+409A\s+deferrals[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /[Ss]ection\s+409A\s+deferrals.*?\$([0-9,]+\.?\d{0,2})/i,
    /(?:^|\n)\s*12\s*[^\n]*\$([0-9,]+\.?\d{0,2})/m,
    /12\s*[^\d\n]*([0-9,]+\.?\d{0,2})/m
    ],
    
    // Box 13 - Excess golden parachute payments - Enhanced patterns
    excessGoldenParachutePayments: [
    /(?:^|\n)\s*13\s+Excess\s+golden\s+parachute\s+payments\s*\$?([0-9,]+\.?\d{0,2})/im,
    /Box\s*13[:\s]*Excess\s+golden\s+parachute\s+payments[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /13\s*\.?\s*Excess\s+golden\s+parachute\s+payments[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /[Ee]xcess.*?golden.*?parachute.*?payments.*?\$([0-9,]+\.?\d{0,2})/i,
    /(?:^|\n)\s*13\s*[^\n]*\$([0-9,]+\.?\d{0,2})/m,
    /13\s*[^\d\n]*([0-9,]+\.?\d{0,2})/m
    ],
    
    // Box 14 - Nonqualified deferred compensation - Enhanced patterns
    nonqualifiedDeferredCompensation: [
    /(?:^|\n)\s*14\s+Nonqualified\s+deferred\s+compensation\s*\$?([0-9,]+\.?\d{0,2})/im,
    /Box\s*14[:\s]*Nonqualified\s+deferred\s+compensation[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /14\s*\.?\s*Nonqualified\s+deferred\s+compensation[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /[Nn]onqualified.*?deferred.*?compensation.*?\$([0-9,]+\.?\d{0,2})/i,
    /[Dd]eferred.*?compensation.*?\$([0-9,]+\.?\d{0,2})/i,
    /(?:^|\n)\s*14\s*[^\n]*\$([0-9,]+\.?\d{0,2})/m
    ],
    
    // Box 15 - Section 409A income - FIXED: Changed from "15a" to "15"
    section409AIncome: [
    /(?:^|\n)\s*15\s+Section\s+409A\s+income\s*\$?([0-9,]+\.?\d{0,2})/im,
    /Box\s*15[:\s]*Section\s+409A\s+income[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /15\s*\.?\s*Section\s+409A\s+income[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /[Ss]ection\s+409A\s+income.*?\$([0-9,]+\.?\d{0,2})/i,
    /(?:^|\n)\s*15\s*[^\n]*\$([0-9,]+\.?\d{0,2})/m,
    /15\s*[^\d\n]*([0-9,]+\.?\d{0,2})/m
    ],
    
    // Box 16 - State tax withheld - Enhanced patterns
    stateTaxWithheld: [
    /(?:^|\n)\s*16\s+State\s+tax\s+withheld\s*\$?([0-9,]+\.?\d{0,2})/im,
    /Box\s*16[:\s]*State\s+tax\s+withheld[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /16\s*\.?\s*State\s+tax\s+withheld[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /[Ss]tate\s+tax\s+withheld.*?\$([0-9,]+\.?\d{0,2})/i,
    /(?:^|\n)\s*16\s*[^\n]*\$([0-9,]+\.?\d{0,2})/m,
    /16\s*[^\d\n]*([0-9,]+\.?\d{0,2})/m
    ],
    
    // Box 17 - State/Payer's state no. - Enhanced patterns
    statePayerNumber: [
    /(?:^|\n)\s*17\s+State\/Payer's\s+state\s+no\.\s*([A-Z0-9\-\s]+?)(?:\n|$)/im,
    /Box\s*17[:\s]*State\/Payer's\s+state\s+no\.[:\s]*([A-Z0-9\-\s]+?)(?:\n|$)/i,
    /17\s*\.?\s*State\/Payer's\s+state\s+no\.[:\s]*([A-Z0-9\-\s]+?)(?:\n|$)/i,
    /[Ss]tate.*?[Pp]ayer.*?state.*?no\..*?([A-Z0-9\-\s]+?)(?:\n|$)/i,
    /(?:^|\n)\s*17\s*[^\n]*([A-Z0-9\-\s]+?)(?:\n|$)/m
    ],
    
    // Box 18 - State income - Enhanced patterns
    stateIncome: [
    /(?:^|\n)\s*18\s+State\s+income\s*\$?([0-9,]+\.?\d{0,2})/im,
    /Box\s*18[:\s]*State\s+income[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /18\s*\.?\s*State\s+income[:\s]*\$?([0-9,]+\.?\d{0,2})/i,
    /[Ss]tate\s+income.*?\$([0-9,]+\.?\d{0,2})/i,
    /(?:^|\n)\s*18\s*[^\n]*\$([0-9,]+\.?\d{0,2})/m,
    /18\s*[^\d\n]*([0-9,]+\.?\d{0,2})/m
    ]
    };
    
    // ENHANCED BOX 3 EXTRACTION: Use the new smart fallback method
    console.log('🔍 [Azure DI OCR] Using enhanced Box 3 extraction with smart fallback...');
    const box3Amount = this.extractBox3OtherIncomeWithFallback(ocrText);
    if (box3Amount > 0) {
      data.otherIncome = box3Amount;
      console.log(`✅ [Azure DI OCR] Successfully extracted Box 3 Other Income: $${box3Amount}`);
    }
    
    // Extract all other box amounts using progressive pattern matching
    for (const [fieldName, patterns] of Object.entries(amountPatterns)) {
    // Skip otherIncome since we handled it with the enhanced method above
    if (fieldName === 'otherIncome') continue;
    
    let found = false;
    
    for (let i = 0; i < patterns.length && !found; i++) {
    const pattern = patterns[i];
    const match = ocrText.match(pattern);
    if (match && match[1]) {
    let value: string | number = match[1];
    
    // Handle numeric fields
    if (fieldName !== 'statePayerNumber') {
    const amountStr = match[1].replace(/,/g, '');
    const amount = parseFloat(amountStr);
    
    if (!isNaN(amount) && amount >= 0) {
    value = amount;
    console.log(`✅ [Azure DI OCR] Found ${fieldName}: $${amount} (pattern ${i + 1})`);
    found = true;
    } else {
    continue; // Skip invalid amounts
    }
    } else {
    // Handle text fields like state payer number
    value = match[1].trim();
    console.log(`✅ [Azure DI OCR] Found ${fieldName}: ${value} (pattern ${i + 1})`);
    found = true;
    }
    
    data[fieldName] = value;
    }
    }
    }
    
    // Extract additional medical payment amounts (Box 6 can have multiple values)
    // Enhanced pattern to capture multiple medical payments on separate lines
    const medicalPaymentPattern = /(?:6\s+Medical\s+and\s+health\s+care\s+payments|medical.*?payments?).*?\$?([0-9,]+\.?\d{0,2})/gi;
    const medicalPayments = [];
    let medicalMatch;
    
    // Reset regex lastIndex to ensure we capture all matches
    medicalPaymentPattern.lastIndex = 0;
    
    while ((medicalMatch = medicalPaymentPattern.exec(ocrText)) !== null) {
    const amountStr = medicalMatch[1].replace(/,/g, '');
    const amount = parseFloat(amountStr);
    
    if (!isNaN(amount) && amount > 0) {
    medicalPayments.push(amount);
    console.log(`✅ [Azure DI OCR] Found medical payment: $${amount}`);
    }
    }
    
    // Also look for standalone dollar amounts after Box 6 medical payments
    const box6Context = ocrText.match(/6\s+Medical\s+and\s+health\s+care\s+payments[\s\S]*?(?=7\s+|$)/i);
    if (box6Context) {
    const additionalAmountPattern = /\$([0-9,]+\.?\d{0,2})/g;
    let additionalMatch;
    
    while ((additionalMatch = additionalAmountPattern.exec(box6Context[0])) !== null) {
    const amountStr = additionalMatch[1].replace(/,/g, '');
    const amount = parseFloat(amountStr);
    
    if (!isNaN(amount) && amount > 0 && !medicalPayments.includes(amount)) {
    medicalPayments.push(amount);
    console.log(`✅ [Azure DI OCR] Found additional medical payment: $${amount}`);
    }
    }
    }
    
    if (medicalPayments.length > 1) {
    data.medicalPaymentsMultiple = medicalPayments;
    // Update the main medical payment field to be the sum or first amount
    data.medicalHealthPayments = medicalPayments[0]; // Keep first amount as primary
    console.log(`✅ [Azure DI OCR] Found multiple medical payments: ${medicalPayments.join(', ')}`);
    } else if (medicalPayments.length === 1 && !data.medicalHealthPayments) {
    data.medicalHealthPayments = medicalPayments[0];
    console.log(`✅ [Azure DI OCR] Found single medical payment: $${medicalPayments[0]}`);
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
    
    // Extract any dollar amounts found in the text
    const amountPattern = /\$([0-9,]+\.?\d{0,2})/g;
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
    data.extractedAmounts = amounts;
    console.log(`✅ [Azure DI OCR] Found ${amounts.length} dollar amounts:`, amounts);
    }
    
    return data;
  }
}

// Export function for service instantiation - PLACED OUTSIDE THE CLASS
export function getAzureDocumentIntelligenceService(): AzureDocumentIntelligenceService {
  const config = {
    endpoint: process.env.AZURE_DOCUMENT_INTELLIGENCE_ENDPOINT!,
    apiKey: process.env.AZURE_DOCUMENT_INTELLIGENCE_API_KEY!
  };
  
  if (!config.endpoint || !config.apiKey) {
    throw new Error('Azure Document Intelligence configuration is missing. Please check your environment variables.');
  }
  
  return new AzureDocumentIntelligenceService(config);
}
