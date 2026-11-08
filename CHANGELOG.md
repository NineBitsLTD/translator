# Change Log

All notable changes to the "translator" extension are documented in this file.

## [1.3.0]

- **View Translation** at the top of Markdown and plain text files: the whole file translated and shown beside it as a preview, Markdown rendered with its images; the file itself is not changed
- The action that replaces a selection is called **Translate with Replacement**, has the icon of the side bar and goes away with the selection, also when another file is opened
- Fixed in Markdown: an image was torn apart by its `!`, and a sentence could end inside a link or code

## [1.2.0]

- **Translate** among the actions at the top of a text file while text is selected: the selection is replaced by its translation into the language chosen in the side bar
- A selection is left as it is when the file changed while it was being translated
- The button that reads aloud is a speaker, struck through while it speaks; icon buttons have no frame

## [1.1.1]

- The repository of the extension in its manifest

## [1.1.0]

- With the extension TTS / STT Aloud: buttons in the side bar read the text or its translation aloud and record speech to translate
- A model being downloaded is in the list of models, with how much of it is there; models are added in a dialog
- Check boxes choose which of the models installed are used for translating
- Swapping the languages swaps their texts too: the translation is not erased

## [1.0.0]

- Translation on the device with ONNX models: Opus-MT (65 pairs) and M2M100 (100 languages), downloaded in the side bar or chosen on the disk; through English when no model does a pair
- Side bar, editor commands, an API and commands for other extensions; English and Russian
- Code, addresses, identifiers and Markdown stay as they are
- Extension icon: the universe icon of gw with the label TRANSLATOR
