/**
 * ImageController
 *
 * @description :: Server-side actions for handling incoming requests.
 * @help        :: See https://sailsjs.com/docs/concepts/actions
 */

const fs = require('fs');
const path = require('path');
const { promisify } = require('util');
const axios = require('axios');
const sharp = require('sharp');

// 將 fs.unlink 轉換為 Promise 版本
const unlinkAsync = promisify(fs.unlink);

module.exports = {

  /**
   * Upload image file
   *
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  async upload(req, res) {
    try {
      const { patientId, practitionerId } = req.body;

      // 使用 skipper 的 upload 方法處理檔案上傳
      const uploadedFiles = await new Promise((resolve, reject) => {
        req.file('image').upload({ maxBytes: 1073741824 }, (err, files) => {
          if (err) { return reject(err); }
          return resolve(files);
        });
      });

      if (uploadedFiles.length === 0) {
        return res.badRequest({
          success: false,
          err: {
            code: 'E_NO_FILE',
            message: '沒有上傳檔案'
          }
        });
      }

      const fileBuffer = fs.readFileSync(uploadedFiles[0].fd);

      // 檢查是否有檔案被上傳
      if (!fileBuffer || fileBuffer.length === 0) {
        return res.badRequest({
          success: false,
          err: {
            code: 'E_NO_FILE',
            message: '沒有上傳檔案'
          }
        });
      }

      // 檔案大小
      const fileSizeBytes = fileBuffer.length;

      // 偵測是否為影像（透過 sharp 讀取 metadata）
      let metadata = null;
      let imageType = null;
      let isImage = false;
      try {
        metadata = await sharp(fileBuffer).metadata();
        imageType = metadata.format;
        isImage = ['jpeg', 'png', 'gif', 'webp'].includes(imageType);
      } catch (unusedE) {
        isImage = false;
      }

      // 取得檔案資訊
      const apiBaseUrl = sails.config.custom.apiBaseUrl;
      const fhirServerUrl = sails.config.custom.fhirServerUrl;
      const uniqueId = require('crypto').randomBytes(8).toString('hex');
      let filenameFull;
      let fileName;
      let fileExt;
      if (isImage) {
        filenameFull = `${uniqueId}.${imageType}`;
        ({ name: fileName, ext: fileExt } = path.parse(filenameFull));
      } else {
        const originalExt = (path.extname(uploadedFiles[0].filename || '') || '').toLowerCase();
        filenameFull = `${uniqueId}${originalExt}`;
        ({ name: fileName, ext: fileExt } = path.parse(filenameFull));
      }
      const imagePath = path.resolve(sails.config.appPath, 'assets/images', filenameFull);
      const imageUrl = `${apiBaseUrl}/images/${filenameFull}`;

      // 產生縮圖
      let thumbnailFilename = null;
      let thumbnailPath = null;
      let thumbnailUrl = null;
      if (isImage) {
        thumbnailFilename = `${fileName}_thumb${fileExt}`;
        thumbnailPath = path.resolve(sails.config.appPath, 'assets/images', thumbnailFilename);
        thumbnailUrl = `${apiBaseUrl}/images/${thumbnailFilename}`;
      }

      // 將原始圖和縮圖寫入檔案系統
      // 使用 withMetadata() 保留 EXIF 資訊（包括 Orientation）
      if (isImage) {
        await sharp(fileBuffer)
          .withMetadata()
          .toFile(imagePath);

        await sharp(fileBuffer)
          .resize(128, 128)
          .withMetadata()
          .toFile(thumbnailPath);
      } else {
        await fs.promises.writeFile(imagePath, fileBuffer);
      }

      // 建立 FHIR DocumentReference
      const documentReference = {
        resourceType: 'DocumentReference',
        meta: {
          profile: [
            'https://twcore.mohw.gov.tw/ig/twcore/StructureDefinition/DocumentReference-twcore'
          ]
        },
        status: 'current',
        description: 'hah',
        docStatus: 'final',
        type: {
          coding: [
            {
              system: 'http://loinc.org',
              code: '72170-4',
              display: 'Attachment'
            }
          ]
        },
        content: []
      };

      if (isImage) {
        documentReference.content.push({
          attachment: {
            contentType: `image/${imageType}`,
            url: imageUrl,
            size: fileSizeBytes,
            title: 'full-image',
            creation: new Date().toISOString()
          }
        });
        documentReference.content.push({
          attachment: {
            contentType: `image/${imageType}`,
            url: thumbnailUrl,
            title: 'thumbnail',
            creation: new Date().toISOString()
          }
        });
      } else {
        const mimeType = uploadedFiles[0].type || 'application/octet-stream';
        documentReference.content.push({
          attachment: {
            contentType: mimeType,
            url: imageUrl,
            size: fileSizeBytes,
            title: 'file',
            creation: new Date().toISOString()
          }
        });
      }

      if (patientId) {
        documentReference.subject = { reference: `Patient/${patientId}` };
      }

      if (practitionerId) {
        documentReference.author = [{ reference: `Practitioner/${practitionerId}` }];
      }

      let fhirResponse = {};
      try {
        const response = await axios.post(`${fhirServerUrl}/DocumentReference`, documentReference);
        if (response.status === 201) {
          fhirResponse = response.data;
        }
      } catch (fhirErr) {
        sails.log.error('FHIR server error:', fhirErr.response ? fhirErr.response.data : fhirErr.message);
        return res.serverError('Failed to create DocumentReference on FHIR server.');
      }

      // 回傳成功響應
      return res.ok({
        filename: filenameFull,
        size: fileSizeBytes,
        path: `/images/${filenameFull}`,
        'path-thumbnail': isImage ? `/images/${thumbnailFilename}` : null,
        timestamp: Date.now(),
        url: imageUrl,
        delete: `${apiBaseUrl}/delete/${fhirResponse.id}`,
        fhir: fhirResponse
      });

    } catch (err) {
      sails.log.error('File upload error:', err);
      return res.serverError(err);
    }
  },

  /**
   * Delete specific image file and its DocumentReference
   *
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  async delete(req, res) {
    try {
      const { id } = req.params;
      const fhirServerUrl = sails.config.custom.fhirServerUrl;

      if (!id) {
        return res.badRequest({
          success: false,
          err: {
            code: 'E_INVALID_ID',
            message: '無效的 FHIR ID'
          }
        });
      }

      // 1. 從 FHIR Server 取得 DocumentReference 以獲取檔案名稱
      let docRef;
      try {
        const response = await axios.get(`${fhirServerUrl}/DocumentReference/${id}`);
        docRef = response.data;
      } catch (err) {
        sails.log.error('Failed to fetch DocumentReference:', err.response ? err.response.data : err.message);
        if (err.response && err.response.status === 404) {
          return res.status(404).json({ success: false, message: '找不到指定的 FHIR DocumentReference' });
        }
        return res.serverError('無法從 FHIR 伺服器取得 DocumentReference');
      }

      // 2. 從 FHIR Server 取得有連結到這個 DocumentReference 的 ClinicalImpression
      let clinicalImpressions = [];
      try {
        const response = await axios.get(`${fhirServerUrl}/ClinicalImpression?supporting-info=DocumentReference/${id}`);
        if (response.data && response.data.entry) {
          clinicalImpressions = response.data.entry.map(entry => entry.resource);
        }
      } catch (err) {
        sails.log.error('Failed to fetch ClinicalImpressions:', err.response ? err.response.data : err.message);
        // 如果取得失敗，仍繼續執行刪除流程
      }

      // 3. 更新每個 ClinicalImpression，移除 supportingInfo 中的 DocumentReference 參考
      for (const clinicalImpression of clinicalImpressions) {
        if (clinicalImpression.supportingInfo && Array.isArray(clinicalImpression.supportingInfo)) {
          // 過濾掉要刪除的 DocumentReference
          const updatedSupportingInfo = clinicalImpression.supportingInfo.filter(
            info => info.reference !== `DocumentReference/${id}`
          );

          // 如果 supportingInfo 有變更，更新 ClinicalImpression
          if (updatedSupportingInfo.length !== clinicalImpression.supportingInfo.length) {
            clinicalImpression.supportingInfo = updatedSupportingInfo;

            try {
              await axios.put(
                `${fhirServerUrl}/ClinicalImpression/${clinicalImpression.id}`,
                clinicalImpression,
                {
                  headers: {
                    'Content-Type': 'application/fhir+json'
                  }
                }
              );
              sails.log.info(`Updated ClinicalImpression ${clinicalImpression.id} to remove DocumentReference/${id}`);
            } catch (updateErr) {
              sails.log.error(`Failed to update ClinicalImpression ${clinicalImpression.id}:`, updateErr.response ? updateErr.response.data : updateErr.message);
              // 更新失敗不中斷流程
            }
          }
        }
      }

      // 4. 向 FHIR Server 刪除 DocumentReference
      try {
        await axios.delete(`${fhirServerUrl}/DocumentReference/${id}`);
      } catch (err) {
        sails.log.error('Failed to delete DocumentReference:', err.response ? err.response.data : err.message);
        // 即使刪除失敗，我們還是繼續嘗試刪除本地檔案
      }

      // 5. 刪除本地圖片檔案 (原始圖 + 縮圖)
      try {
        for (const content of docRef.content) {
          const fileUrl = content.attachment.url;
          const filename = path.basename(fileUrl);
          const filePath = path.join(sails.config.appPath, 'assets/images', filename);
          if (fs.existsSync(filePath)) {
            await unlinkAsync(filePath);
          }
        }
      } catch (err) {
        sails.log.error('File deletion error:', err);
        return res.serverError({ success: false, message: '檔案刪除失敗，但 FHIR 資源可能已被刪除' });
      }

      return res.ok({
        success: true,
        message: '檔案及對應的 FHIR DocumentReference 已成功刪除'
      });

    } catch (err) {
      sails.log.error('Delete operation failed:', err);
      return res.serverError(err);
    }
  },

  /**
   * Delete all image files
   *
   * @param {Object} req - Request object
   * @param {Object} res - Response object
   */
  async purge(req, res) {
    try {
      const imageDirPath = path.join(sails.config.appPath, 'assets/images');
      const files = await promisify(fs.readdir)(imageDirPath);

      for (const file of files) {
        if (file !== '.gitkeep') {
          await unlinkAsync(path.join(imageDirPath, file));
        }
      }

      return res.ok({
        success: true,
        message: '所有檔案已成功刪除'
      });
    } catch (err) {
      sails.log.error('Files purge error:', err);
      return res.serverError(err);
    }
  }

};
