Task: attach the right photo to each recommendation (EZ "ImageID" drop-down on the Recommendations form).

For each recommendation below, pick the photo that best shows the condition the recommendation fixes.
Prefer photos the inspector marked as hazards. Use the photo descriptions from the vision pass and the
captions. If the recommended item is absent and cannot be photographed (e.g. "Install fire extinguishers",
"Post a fire safety plan"), set noPhotoNeeded = true and imageId = "". If no photo clearly matches, set
imageId = "" and explain. Give up to 3 alternatives (photo ids). For recommendations that already have a
photo, only return them if the current photo is clearly wrong.

Only use photo ids from the list.

# Recommendations
{{recs}}

# Photos (id | caption | marked hazard | description)
{{photos}}
